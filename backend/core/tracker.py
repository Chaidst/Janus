import cv2
import numpy as np
from .constants import DEFAULT_BOX_SIZE, MIN_BOX_SIZE

class CoordinateMapper:
    """Handles mapping between screen coordinates and frame coordinates."""
    def __init__(self, W_f, H_f, W_s, H_s):
        self.W_f, self.H_f = W_f, H_f
        self.W_s, self.H_s = W_s, H_s
        self.aspect_f = W_f / H_f
        self.aspect_s = W_s / H_s if H_s != 0 else 1
        
        if self.aspect_s > self.aspect_f:
            self.s = W_s / W_f
            self.dx = 0
            self.dy = (H_f * self.s - H_s) / 2
        else:
            self.s = H_s / H_f
            self.dx = (W_f * self.s - W_s) / 2
            self.dy = 0

    def to_frame(self, x_s, y_s):
        """Screen coordinates to Frame coordinates."""
        x_f = (x_s + self.dx) / self.s
        y_f = (y_s + self.dy) / self.s
        return x_f, y_f

    def to_screen(self, x_f, y_f):
        """Frame coordinates to Screen coordinates."""
        x_s = x_f * self.s - self.dx
        y_s = y_f * self.s - self.dy
        return x_s, y_s

class TrackerManager:
    """Manages multiple OpenCV trackers and coordinate mapping."""
    def __init__(self):
        self.trackers = {}  # {id: tracker_object}
        self.projection_data = {} # {id: {relative_to, html}}
        
    def _create_tracker(self):
        """Initializes a tracker with fallbacks, supporting both old and new OpenCV APIs."""
        trackers_to_try = [
            (cv2, 'TrackerCSRT', True),
            (cv2, 'TrackerKCF', True),
            (cv2, 'TrackerMIL', True),
            (cv2, 'TrackerCSRT_create', False),
            (cv2, 'TrackerKCF_create', False),
            (cv2, 'TrackerMIL_create', False),
            (getattr(cv2, 'legacy', None), 'TrackerCSRT_create', False),
            (getattr(cv2, 'legacy', None), 'TrackerKCF_create', False)
        ]

        for container, name, is_new_api in trackers_to_try:
            if container is None: continue
            try:
                if is_new_api:
                    tracker_class = getattr(container, name, None)
                    if tracker_class and hasattr(tracker_class, 'create'):
                        return tracker_class.create()
                else:
                    creator = getattr(container, name, None)
                    if creator:
                        return creator()
            except (AttributeError, cv2.error):
                continue
        raise RuntimeError("No suitable OpenCV tracker found. Try installing opencv-contrib-python.")

    def add_tracker(self, pid, frame, x_f, y_f, relative_to, html, box_size=DEFAULT_BOX_SIZE):
        """Initializes a new tracker for a specific point."""
        H_f, W_f = frame.shape[:2]
        
        # Initialize the tracking box centered at the click point
        x0 = int(np.clip(x_f - box_size / 2, 0, W_f - 1))
        y0 = int(np.clip(y_f - box_size / 2, 0, H_f - 1))
        w = int(np.clip(box_size, 1, W_f - x0))
        h = int(np.clip(box_size, 1, H_f - y0))
        
        if w < MIN_BOX_SIZE or h < MIN_BOX_SIZE:
            return False

        tracker = self._create_tracker()
        try:
            # OpenCV init often returns None in newer versions instead of True/False
            res = tracker.init(frame, (x0, y0, w, h))
            if res is False:
                return False
        except cv2.error:
            return False
            
        self.trackers[pid] = tracker
        self.projection_data[pid] = {
            'relative_to': relative_to, 
            'html': html
        }
        return True

    def update(self, frame, mapper):
        """Updates all active trackers and returns their new screen positions."""
        updates = []
        to_remove = []
        
        for pid, tracker in list(self.trackers.items()):
            success, box = tracker.update(frame)
            if success:
                x, y, w, h = [float(v) for v in box]
                # Center of the tracked box
                cx_f, cy_f = x + w / 2.0, y + h / 2.0
                cx_s, cy_s = mapper.to_screen(cx_f, cy_f)
                
                updates.append({
                    'id': pid,
                    'attach_point': [cx_s, cy_s],
                    'relative_to': self.projection_data[pid]['relative_to']
                })
            else:
                to_remove.append(pid)
                
        for pid in to_remove:
            self.remove_tracker(pid)
            
        return updates, to_remove

    def remove_tracker(self, pid):
        """Removes a tracker and its data."""
        self.trackers.pop(pid, None)
        self.projection_data.pop(pid, None)
