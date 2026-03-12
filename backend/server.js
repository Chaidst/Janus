const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../frontend')));

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('video-frame', (data) => {
        // Handle video frame (base64)
        console.log('Received video frame from:', socket.id);
        // We could also broadcast it or process it here.
    });

    socket.on('audio-chunk', (data) => {
        // Handle audio chunk (Float32Array converted to ArrayBuffer/Buffer)
        console.log('Received audio chunk from:', socket.id);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
