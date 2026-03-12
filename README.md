# Janus: AI Augmented Reality Experience

A real-time augmented reality application for children using Gemini Live and Django.

## Prerequisites

- Python 3.10+
- A valid [Google Gemini API Key](https://aistudio.google.com/app/apikey)

## Setup Instructions

1.  **Clone the repository and navigate to the project root.**

2.  **Configure Environment Variables:**
    Create a `.env` file in the `backend/` directory and add your Google API Key:
    ```bash
    echo "GOOGLE_API_KEY=your_api_key_here" > backend/.env
    ```

3.  **Install Dependencies:**
    It is recommended to use a virtual environment:
    ```bash
    python -m venv venv
    source venv/bin/activate  # On Windows use `venv\Scripts\activate`
    pip install -r backend/requirements.txt
    ```

4.  **Initialize the Database:**
    ```bash
    cd backend
    python manage.py migrate
    ```

5.  **Start the Server:**
    ```bash
    python manage.py runserver
    ```

6.  **Access the Application:**
    - Open your browser and go to `http://127.0.0.1:8000/`.
    - Click the "Activate Experience" button to start.
    - Grant the browser permission to access your camera and microphone.

## Project Structure

- `backend/`: Django application with Channels and Gemini Live integration.
- `frontend/`: Static files (HTML, CSS, JS) including A-Frame AR elements.
- `backend/core/`: Main backend logic for audio/video processing and Gemini interaction.
- `frontend/scripts/`: Client-side logic for media streaming and AR rendering.
