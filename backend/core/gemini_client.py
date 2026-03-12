import asyncio
import base64
import json
import os
import traceback
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()

# Keep-alive interval in seconds to prevent session timeouts
KEEP_ALIVE_INTERVAL = 30

class GeminiLiveClient:
    def __init__(self, system_instruction, tools=None):
        self.api_key = os.getenv("GOOGLE_API_KEY")
        if not self.api_key:
            raise ValueError("GOOGLE_API_KEY not found in environment")
        
        self.client = genai.Client(api_key=self.api_key, http_options={'api_version': 'v1alpha'})
        self.system_instruction = system_instruction
        self.tools = tools or []
        self.session = None
        self.model_id = "gemini-2.5-flash-native-audio-preview-12-2025"

    async def connect(self, on_message_callback):
        config = types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            system_instruction=types.Content(
                parts=[types.Part(text=self.system_instruction)]
            ),
            tools=self.tools,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Puck" # Warm, caregiver-style voice
                    )
                )
            )
        )

        try:
            print(f"Connecting to Gemini Live with model: {self.model_id}...")
            # Validate config and tools
            # print(f"Config: {config}")
            session = self.client.aio.live.connect(model=self.model_id, config=config)
            async with session as session:
                print("Gemini Live session established")
                self.session = session
                # If there's a callback for session ready, call it
                if hasattr(self, 'on_ready_callback') and self.on_ready_callback:
                    await self.on_ready_callback()

                # Keep-alive loop to prevent session timeout
                async def keep_alive():
                    try:
                        while True:
                            await asyncio.sleep(KEEP_ALIVE_INTERVAL)
                            if self.session:
                                # Send empty text to keep connection alive
                                try:
                                    await self.session.send_realtime_input(text="")
                                except Exception as e:
                                    print(f"Keep-alive send error: {e}")
                                    break
                                # print("Sent keep-alive to Gemini")
                    except asyncio.CancelledError:
                        pass
                    except Exception as e:
                        print(f"Keep-alive error: {e}")

                ka_task = asyncio.create_task(keep_alive())

                try:
                    async for message in session.receive():
                        # print(f"Raw message from Gemini: {message}") # Debug all messages
                        if message.setup_complete:
                            print("Gemini setup complete in client loop")
                        if message.server_content and message.server_content.turn_complete:
                            # Log but don't stop the loop
                            pass
                        await on_message_callback(message)
                except Exception as e:
                    print(f"Error in receive loop: {type(e).__name__}: {e}")
                    # traceback.print_exc()
                finally:
                    print("Exiting Gemini receive loop")
                    ka_task.cancel()
                    try:
                        await ka_task
                    except asyncio.CancelledError:
                        pass
        except Exception as e:
            print(f"Gemini Live Error: {type(e).__name__}: {e}")
            traceback.print_exc()
            # If we have an on_error_callback, use it
            if hasattr(self, 'on_error_callback') and self.on_error_callback:
                await self.on_error_callback(str(e))
        finally:
            print("Gemini Live session closed")
            self.session = None

    async def send_audio(self, audio_data):
        if self.session:
            try:
                await self.session.send_realtime_input(
                    audio=types.Blob(data=audio_data, mime_type="audio/pcm;rate=16000")
                )
            except Exception as e:
                print(f"Error sending audio: {e}")
        else:
            print("Gemini session not ready, dropping audio")

    async def send_video(self, frame_b64):
        if self.session:
            try:
                # frame_b64 is data:image/jpeg;base64,...
                if ',' in frame_b64:
                    frame_data = base64.b64decode(frame_b64.split(',')[1])
                else:
                    frame_data = base64.b64decode(frame_b64)

                await self.session.send_realtime_input(
                    video=types.Blob(data=frame_data, mime_type="image/jpeg")
                )
            except Exception as e:
                print(f"Error sending video: {e}")

    async def send_text(self, text):
        if self.session:
            await self.session.send_realtime_input(text=text)

    async def send_tool_result(self, call_id, name, result):
        if self.session:
            await self.session.send_realtime_input(
                tool_response=types.LiveClientToolResponse(
                    function_responses=[
                        types.LiveClientFunctionResponse(
                            name=name,
                            id=call_id,
                            response=result
                        )
                    ]
                )
            )

    async def compact_summary(self, summary):
        """Use Gemini Flash (non-live) to optimize/compact a conversation summary."""
        try:
            response = await self.client.aio.models.generate_content(
                model="gemini-2.5-flash-native-audio-preview-12-2025",
                contents=f"Please compact and optimize the following conversation summary for a senior architect building an AR app for children. Keep only the most relevant developmental and environmental information: {summary}"
            )
            return response.text
        except Exception as e:
            print(f"Error compacting summary: {e}")
            return summary # Fallback to original summary if optimization fails
