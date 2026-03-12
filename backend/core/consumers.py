import json
from channels.generic.websocket import AsyncWebsocketConsumer

class AudioConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        await self.accept()
        print("WebSocket connected")

    async def disconnect(self, close_code):
        print(f"WebSocket disconnected: {close_code}")

    async def receive(self, text_data=None, bytes_data=None):
        if text_data:
            data = json.loads(text_data)
            msg_type = data.get('type')
            if msg_type == 'audio':
                # Handle base64 encoded audio
                pass
            elif msg_type == 'video':
                # Handle base64 encoded video frame
                if not hasattr(self, 'video_packet_count'):
                    self.video_packet_count = 0
                self.video_packet_count += 1
                
                if self.video_packet_count % 50 == 0:
                    print(f"Received 50 video frames. Total: {self.video_packet_count}")
                    await self.send(text_data=json.dumps({
                        'status': 'streaming_video',
                        'video_packets_received': self.video_packet_count
                    }))

        if bytes_data:
            # Current implementation handles binary audio data
            # Check for a simple header or use a structured approach
            # For simplicity, let's assume if it's binary it's audio for now,
            # or we can switch everything to JSON/Base64 for mixed streams.
            
            if not hasattr(self, 'packet_count'):
                self.packet_count = 0
            self.packet_count += 1
            if self.packet_count % 100 == 0:
                await self.send(text_data=json.dumps({
                    'status': 'streaming',
                    'packets_received': self.packet_count
                }))
