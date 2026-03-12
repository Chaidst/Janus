import json
import base64
import cv2
import numpy as np
import asyncio
import os
import traceback
from channels.generic.websocket import AsyncWebsocketConsumer
from asgiref.sync import sync_to_async
from google.genai import types
from .models import Memory
from .tracker import CoordinateMapper, TrackerManager
from .gemini_client import GeminiLiveClient
from .constants import (
    MSG_TYPE_CONSTRAINTS, MSG_TYPE_VIDEO, MSG_TYPE_REQUEST_PROJECTION,
    MSG_TYPE_UNPROJECT, MSG_TYPE_UPDATE_POSITION, MSG_TYPE_PROJECT,
    FRAME_PREFIX, AUDIO_PACKET_INTERVAL
)

SYSTEM_INSTRUCTION = """
You are a senior architect, pushing the technology frontier forward.
You are building an augmented reality application designed to support children ages 2 to 6 through
their crucial early developmental stages. This application will support children's creativity and
development as they learn to speak, learn to read books, learn to do basic arithmetic, learn to draw,
and in general—learn who they are.

This state-of-the-art application leverages Gemini Live to:
- Share the child's perspective: Visually process and understand the physical environment alongside
  the child in real-time.
- Enhance their environment: Seamlessly project engaging augmented reality elements directly into
  the child's visual field.
- Nurture curiosity: Speak in a natural, caregiver-style tone, acting as an active listener and gentle
  guide rather than just giving the answers.
- React based on context: Using real-time visual cues to ask open-ended questions about what the child
  is doing—like counting the physical blocks they are holding or encouraging them to tell a story about
  a drawing they just made.
- Listen actively and respond appropriately: Operate seamlessly without requiring a wake word, intuitively
  knowing when to offer a meaningful comment and when to remain quietly observant while the child focuses.

Specifically, you must be able to:
1. Use visual recognition to identify objects in the environment. This allows you to understand the physical world and discuss information relevant to it.
2. Recognize physical properties, states (e.g., instability), and non-verbal cues within view to provide context-aware feedback.
3. Use augmented reality capabilities to project objects into the child's visual field via the 'project' tool call. 
   - You must build these educational visuals entirely from scratch using code (A-Frame HTML), as third-party resources are inaccessible.
   - You must generate a unique Reference ID for each visual.
   - You must pinpoint exactly where it should appear via an anchor point (attach_point) and specify positioning (relative_to).
4. Manage the lifecycle of these visuals: proactively issue 'unproject' tool calls referencing the ID to clear visuals when they are no longer relevant or distracting.
5. Save particularly important information permanently (e.g., child's birthday, favorite color) via 'save_memory' and recall it via 'recall_memory'.
6. Compact your context window via 'compact_context' when it fills up with less useful information.

Always prioritize exploration over providing direct answers. Be sensitive to the child's emotional state but maintain boundaries. 
Never assume a parental role. If it feels distracting to interact (e.g., child is talking to someone else), remain quiet but continue observing.
"""

PROJECT_TOOL = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="project",
            description="Render an A-Frame AR element on top of the webcam feed.",
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "id": types.Schema(type="STRING", description="Unique ref ID."),
                    "attach_point": types.Schema(
                        type="ARRAY",
                        items=types.Schema(type="NUMBER"),
                        description="[x, y] coordinates in normalized space (0-1000)."
                    ),
                    "relative_to": types.Schema(
                        type="STRING", 
                        enum=["top", "left", "right", "bottom"],
                        description="Positioning relative to the object."
                    ),
                    "html": types.Schema(type="STRING", description="A-Frame HTML data.")
                },
                required=["id", "attach_point", "html"]
            )
        )
    ]
)

UNPROJECT_TOOL = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="unproject",
            description="Remove an AR experience from the user's view.",
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "id": types.Schema(type="STRING", description="Unique ref ID.")
                },
                required=["id"]
            )
        )
    ]
)

SAVE_MEMORY_TOOL = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="save_memory",
            description="Save important information about the child permanently.",
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "key": types.Schema(type="STRING", description="The type of information (e.g., 'favorite_color')."),
                    "value": types.Schema(type="STRING", description="The value to remember.")
                },
                required=["key", "value"]
            )
        )
    ]
)

RECALL_MEMORY_TOOL = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="recall_memory",
            description="Recall saved information about the child.",
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "key": types.Schema(type="STRING", description="The key to recall (optional). If omitted, returns all.")
                }
            )
        )
    ]
)

COMPACT_CONTEXT_TOOL = types.Tool(
    function_declarations=[
        types.FunctionDeclaration(
            name="compact_context",
            description="Defer to Gemini Flash to compact the context window to only relevant information.",
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "summary": types.Schema(type="STRING", description="Current conversation summary to be optimized.")
                }
            )
        )
    ]
)

class AudioConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        await self.accept()
        
        if not os.getenv("GOOGLE_API_KEY"):
            print("ERROR: GOOGLE_API_KEY not found in environment")
            await self.send(text_data=json.dumps({
                'type': 'status',
                'status': 'error',
                'message': 'GOOGLE_API_KEY not found. Please check your .env file in the backend/ directory.'
            }))
            # Still initialize other things but Gemini won't work
        
        self.tracker_manager = TrackerManager()
        self.constraints = {'width': 0, 'height': 0}
        self.last_frame = None
        self.last_frame_dims = None
        
        # Use the recommended native audio model from gemini-live-api-dev skill
        self.gemini_client = GeminiLiveClient(
            system_instruction=SYSTEM_INSTRUCTION,
            tools=[PROJECT_TOOL, UNPROJECT_TOOL, SAVE_MEMORY_TOOL, RECALL_MEMORY_TOOL, COMPACT_CONTEXT_TOOL]
        )
        self.gemini_client.on_ready_callback = self.on_gemini_ready
        self.gemini_client.on_error_callback = self.on_gemini_error
        
        # Start Gemini connection in background
        self.gemini_task = asyncio.create_task(
            self.gemini_client.connect(self.on_gemini_message)
        )
        # Add a callback to log if the task ends unexpectedly
        def task_done_callback(t):
            try:
                t.result()
            except asyncio.CancelledError:
                pass
            except Exception as e:
                print(f"Gemini task failed with exception: {e}")
                traceback.print_exc()
        self.gemini_task.add_done_callback(task_done_callback)
        
        await self.send(text_data=json.dumps({
            'type': 'status',
            'status': 'connected',
            'message': 'WebSocket connected and Gemini Live initializing'
        }))
        print("WebSocket connected and Gemini Live initialized")

    async def disconnect(self, close_code):
        if hasattr(self, 'gemini_task'):
            self.gemini_task.cancel()
        print(f"WebSocket disconnected: {close_code}")

    async def on_gemini_ready(self):
        """Called when Gemini Live session is established."""
        await self.send(text_data=json.dumps({
            'type': 'status',
            'status': 'ready',
            'message': 'Gemini Live is ready'
        }))
        print("Gemini Live session ready")

    async def on_gemini_error(self, error):
        """Called when Gemini Live session fails."""
        await self.send(text_data=json.dumps({
            'type': 'status',
            'status': 'error',
            'message': f'Gemini Live error: {error}'
        }))
        print(f"Gemini Live session error: {error}")
        # Close the frontend socket if Gemini connection fails
        await self.close()

    async def on_gemini_message(self, message):
        """Handle incoming messages from Gemini Live."""
        try:
            # Log all message types for debugging
            # print(f"Gemini message: {message}")
            if message.setup_complete:
                print("Gemini setup complete")
            
            # Print turn complete for debugging
            if message.server_content and message.server_content.turn_complete:
                print("Gemini turn complete")
                # Ensure we don't accidentally close here, just log
            
            if message.tool_call:
                print(f"Gemini tool call: {message.tool_call}")
            
            # Handle Server Content (Audio/Transcripts)
            if message.server_content:
                content = message.server_content
                if content.model_turn:
                    for part in content.model_turn.parts:
                        if part.inline_data:
                            # Forward audio to frontend
                            # print(f"Received {len(part.inline_data.data)} bytes of audio from Gemini")
                            await self.send(bytes_data=part.inline_data.data)
                        if part.text:
                            print(f"Gemini transcript: {part.text}")
                
                if content.interrupted:
                    print("Gemini interrupted")
                    # Notify frontend to stop playing audio
                    await self.send(text_data=json.dumps({'type': 'interrupted'}))

            # Handle Tool Calls
            if message.tool_call:
                for call in message.tool_call.function_calls:
                    if call.name == 'project':
                        await self.handle_gemini_project(call.id, call.arguments)
                    elif call.name == 'unproject':
                        await self.handle_gemini_unproject(call.id, call.arguments)
                    elif call.name == 'save_memory':
                        key = call.arguments.get('key')
                        value = call.arguments.get('value')
                        await sync_to_async(Memory.objects.update_or_create)(key=key, defaults={'value': value})
                        await self.gemini_client.send_tool_result(call.id, 'save_memory', {"success": True})
                    elif call.name == 'compact_context':
                        summary = call.arguments.get('summary', '')
                        optimized = await self.gemini_client.compact_summary(summary)
                        # Save the summary to memory for potential cross-session recall
                        await sync_to_async(Memory.objects.update_or_create)(key='session_summary', defaults={'value': optimized})
                        await self.gemini_client.send_tool_result(call.id, 'compact_context', {"success": True, "optimized_summary": optimized})
                    elif call.name == 'recall_memory':
                        key = call.arguments.get('key')
                        if key:
                            mem = await sync_to_async(Memory.objects.filter(key=key).first)()
                            res = mem.value if mem else "No memory found for this key"
                        else:
                            mems = await sync_to_async(list)(Memory.objects.all())
                            res = {m.key: m.value for m in mems}
                        await self.gemini_client.send_tool_result(call.id, 'recall_memory', {"value": res})

        except Exception as e:
            print(f"Error in on_gemini_message: {e}")

    async def handle_gemini_project(self, call_id, args):
        pid = args.get('id')
        attach_point = args.get('attach_point') # [x, y] in 0-1000
        relative_to = args.get('relative_to', 'top')
        html = args.get('html')
        
        success = False
        if attach_point and len(attach_point) == 2 and self.last_frame is not None:
            # Map normalized 0-1000 to frame pixels
            W_f, H_f = self.last_frame_dims
            x_f = (attach_point[0] / 1000.0) * W_f
            y_f = (attach_point[1] / 1000.0) * H_f
            
            if self.tracker_manager.add_tracker(pid, self.last_frame, x_f, y_f, relative_to, html):
                # We need to send screen coordinates to the frontend
                mapper = self.get_mapper()
                if mapper:
                    x_s, y_s = mapper.to_screen(x_f, y_f)
                    await self.send(text_data=json.dumps({
                        'type': MSG_TYPE_PROJECT,
                        'id': pid,
                        'attach_point': [x_s, y_s],
                        'relative_to': relative_to,
                        'html': html
                    }))
                    success = True
        
        # Always reply to Gemini so it knows the tool finished
        await self.gemini_client.send_tool_result(call_id, 'project', {"success": success})

    async def handle_gemini_unproject(self, call_id, args):
        pid = args.get('id')
        removed_id = self.tracker_manager.remove_tracker(pid)
        # Use the actual ID that was removed if found, otherwise the requested one for frontend fuzzy fallback
        notify_id = removed_id if removed_id else pid
        await self.send(text_data=json.dumps({'type': MSG_TYPE_UNPROJECT, 'id': notify_id}))
        await self.gemini_client.send_tool_result(call_id, 'unproject', {"success": True})

    def get_mapper(self):
        """Returns a CoordinateMapper for the current frame and screen dimensions."""
        if not self.last_frame_dims:
            return None
        W_f, H_f = self.last_frame_dims
        W_s, H_s = self.constraints.get('width', 0), self.constraints.get('height', 0)
        if W_s == 0 or H_s == 0:
            return None
        return CoordinateMapper(W_f, H_f, W_s, H_s)

    async def handle_video(self, frame_b64):
        """Processes video frame, updates trackers, and sends position updates."""
        if not frame_b64.startswith(FRAME_PREFIX):
            return

        # Forward video to Gemini Live if session is ready
        if self.gemini_client.session:
            await self.gemini_client.send_video(frame_b64)

        img_data = base64.b64decode(frame_b64.split(',')[1])
        nparr = np.frombuffer(img_data, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if frame is None:
            return

        self.last_frame = frame
        H_f, W_f = frame.shape[:2]
        self.last_frame_dims = (W_f, H_f)
        
        mapper = self.get_mapper()
        if not mapper:
            return
            
        updates, to_remove = self.tracker_manager.update(frame, mapper)
        
        for update in updates:
            await self.send(text_data=json.dumps({
                'type': MSG_TYPE_UPDATE_POSITION,
                **update
            }))
        
        for pid in to_remove:
            await self.send(text_data=json.dumps({'type': MSG_TYPE_UNPROJECT, 'id': pid}))

    async def handle_constraints(self, data):
        self.constraints['width'] = data.get('width', 0)
        self.constraints['height'] = data.get('height', 0)

    async def handle_request_projection(self, data):
        # Notify Gemini about user interest
        attach_point = data.get('attach_point')
        if attach_point:
            await self.gemini_client.send_text(
                text=f"The user clicked at {attach_point}. What is there? Should I project something?"
            )
        
        # Original logic for manual tracking if desired (disabled for now to favor Gemini)
        pid = data.get('id')
        html = data.get('html')
        relative_to = data.get('relative_to', 'top')
        
        mapper = self.get_mapper()
        if mapper and attach_point and self.last_frame is not None:
            x_f, y_f = mapper.to_frame(attach_point[0], attach_point[1])
            self.tracker_manager.add_tracker(pid, self.last_frame, x_f, y_f, relative_to, html)
            # We don't need to send PROJECT back if it was a user click, 
            # or maybe we do to confirm. Let's send it.
            await self.send(text_data=json.dumps({
                'type': MSG_TYPE_PROJECT,
                'id': pid,
                'attach_point': attach_point,
                'relative_to': relative_to,
                'html': html
            }))

    async def handle_unproject(self, data):
        pid = data.get('id')
        removed_id = self.tracker_manager.remove_tracker(pid)
        notify_id = removed_id if removed_id else pid
        await self.send(text_data=json.dumps({'type': MSG_TYPE_UNPROJECT, 'id': notify_id}))

    async def handle_audio_stream(self, bytes_data):
        # Forward audio to Gemini Live
        if self.gemini_client.session:
            # print(f"Forwarding {len(bytes_data)} bytes of audio to Gemini")
            await self.gemini_client.send_audio(bytes_data)
        else:
            # print("Gemini session not ready, dropping audio")
            pass

        # Simple packet counting for audio streaming
        if not hasattr(self, 'packet_count'): self.packet_count = 0
        self.packet_count += 1
        if self.packet_count % AUDIO_PACKET_INTERVAL == 0:
            print(f"Audio packets received: {self.packet_count}")
            await self.send(text_data=json.dumps({
                'status': 'streaming',
                'packets_received': self.packet_count
            }))

    async def receive(self, text_data=None, bytes_data=None):
        if text_data:
            try:
                data = json.loads(text_data)
            except json.JSONDecodeError:
                print(f"Failed to decode JSON from text_data: {text_data[:100]}...")
                return

            msg_type = data.get('type')
            
            if msg_type == MSG_TYPE_CONSTRAINTS:
                await self.handle_constraints(data)
                
            elif msg_type == MSG_TYPE_VIDEO:
                frame_data = data.get('data')
                if frame_data:
                    await self.handle_video(frame_data)

            elif msg_type == MSG_TYPE_REQUEST_PROJECTION:
                # User-initiated projection (e.g., via click)
                # We can either handle it locally or inform Gemini
                await self.handle_request_projection(data)

            elif msg_type == MSG_TYPE_UNPROJECT:
                await self.handle_unproject(data)
                
            elif msg_type == 'text':
                # Allow text input to Gemini if provided
                await self.gemini_client.send_text(text=data.get('text'))

        if bytes_data:
            await self.handle_audio_stream(bytes_data)
