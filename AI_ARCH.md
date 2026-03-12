# Janus - Real-time Video/Audio Streaming & Object Tracking

Janus is a web-based platform that enables real-time video and audio streaming from the client to a server, which performs object tracking and projects metadata back to the client's screen.

## Project Architecture

The project is split into two main components:
- **Frontend**: A vanilla JavaScript application that captures media and renders tracking information.
- **Backend**: A Django-based server using Django Channels for asynchronous WebSocket communication and OpenCV for image processing.

### Technology Stack
- **Frontend**: HTML5, CSS3, JavaScript (ES6+), WebSockets, WebRTC (MediaDevices API), AudioWorklet.
- **Backend**: Python 3.x, Django, Django Channels (Daphne), OpenCV (opencv-contrib-python), NumPy.

---

## Component Overview

### 1. Frontend (`/frontend/`)
The frontend is responsible for media capture, encoding, and rendering.

- **`scripts/main.js`**: Entry point. Orchestrates the initialization of UI components and media managers.
- **`scripts/managers.js`**:
    - `SocketManager`: Handles WebSocket lifecycle, message serialization, and routing.
    - `MediaManager`: Captures camera/microphone streams, performs frame downscaling, and handles the `AudioWorklet` for low-latency audio capture.
- **`scripts/tools.js`**: Manages the "projection" of HTML elements onto the video feed based on coordinates received from the backend.
- **`scripts/audio-processor.js`**: An `AudioWorkletProcessor` that extracts raw audio buffers to be sent over WebSockets.
- **`scripts/indicator.js`**: Visual feedback for connection status.

### 2. Backend (`/backend/`)
The backend provides the processing logic for tracking and stream management.

- **`core/consumers.py`**: The WebSocket consumer (`AudioConsumer`). It routes incoming messages (video, audio, constraints) and manages the session-specific `TrackerManager`.
- **`core/tracker.py`**:
    - `TrackerManager`: Manages multiple OpenCV trackers (e.g., CSRT, KCF). It handles tracker initialization on a specific frame region and updates their positions in subsequent frames.
    - `CoordinateMapper`: Maps coordinates between the client's screen (which might be resized) and the server's processed video frames.
- **`core/constants.py`**: Shared constants for message types and tracking configurations.

---

## Data Flow & WebSocket Protocol

Communication between client and server happens over a single WebSocket (`/ws/stream/`).

### Client → Server Messages
- `CONSTRAINTS`: Sends the current viewport dimensions for coordinate mapping.
- `VIDEO`: JPEG-encoded video frames as Base64 strings.
- `AUDIO`: Raw audio buffer packets (binary).
- `REQUEST_PROJECTION`: Request to start tracking an object at a specific (x, y) coordinate.
- `UNPROJECT`: Request to stop tracking a specific object.

### Server → Client Messages
- `PROJECT`: Confirmation of a new tracked object.
- `UPDATE_POSITION`: Updated screen coordinates for all active trackers.
- `UNPROJECT`: Notification that a tracker was lost or removed.
- `streaming`: Status updates for audio packet reception.

---

## Installation & Setup

### Backend
1. Navigate to `backend/`.
2. Install dependencies: `pip install -r requirements.txt`.
3. Run migrations: `python manage.py migrate`.
4. Start the server: `python manage.py runserver`.

### Frontend
- The frontend is served statically (or via Django's static files in production). For development, opening `frontend/index.html` via a local server (or Django) is sufficient.
