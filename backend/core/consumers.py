import json
import base64
import cv2
import numpy as np
from channels.generic.websocket import AsyncWebsocketConsumer
from .tracker import CoordinateMapper, TrackerManager
from .constants import (
    MSG_TYPE_CONSTRAINTS, MSG_TYPE_VIDEO, MSG_TYPE_REQUEST_PROJECTION,
    MSG_TYPE_UNPROJECT, MSG_TYPE_UPDATE_POSITION, MSG_TYPE_PROJECT,
    FRAME_PREFIX, AUDIO_PACKET_INTERVAL
)

class AudioConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        await self.accept()
        self.tracker_manager = TrackerManager()
        self.constraints = {'width': 0, 'height': 0}
        self.last_frame = None
        self.last_frame_dims = None
        print("WebSocket connected")

    async def disconnect(self, close_code):
        print(f"WebSocket disconnected: {close_code}")

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
        pid = data.get('id')
        attach_point = data.get('attach_point') # [x_s, y_s]
        html = data.get('html')
        relative_to = data.get('relative_to', 'top')
        
        mapper = self.get_mapper()
        if mapper and attach_point and self.last_frame is not None:
            x_f, y_f = mapper.to_frame(attach_point[0], attach_point[1])
            
            if self.tracker_manager.add_tracker(pid, self.last_frame, x_f, y_f, relative_to, html):
                await self.send(text_data=json.dumps({
                    'type': MSG_TYPE_PROJECT,
                    'id': pid,
                    'attach_point': attach_point,
                    'relative_to': relative_to,
                    'html': html
                }))

    async def handle_unproject(self, data):
        pid = data.get('id')
        self.tracker_manager.remove_tracker(pid)
        await self.send(text_data=json.dumps({'type': MSG_TYPE_UNPROJECT, 'id': pid}))

    async def handle_audio_stream(self, bytes_data):
        # Simple packet counting for audio streaming
        if not hasattr(self, 'packet_count'): self.packet_count = 0
        self.packet_count += 1
        if self.packet_count % AUDIO_PACKET_INTERVAL == 0:
            await self.send(text_data=json.dumps({
                'status': 'streaming',
                'packets_received': self.packet_count
            }))

    async def receive(self, text_data=None, bytes_data=None):
        if text_data:
            data = json.loads(text_data)
            msg_type = data.get('type')
            
            if msg_type == MSG_TYPE_CONSTRAINTS:
                await self.handle_constraints(data)
                
            elif msg_type == MSG_TYPE_VIDEO:
                frame_data = data.get('data')
                if frame_data:
                    await self.handle_video(frame_data)

            elif msg_type == MSG_TYPE_REQUEST_PROJECTION:
                await self.handle_request_projection(data)

            elif msg_type == MSG_TYPE_UNPROJECT:
                await self.handle_unproject(data)

        if bytes_data:
            await self.handle_audio_stream(bytes_data)
