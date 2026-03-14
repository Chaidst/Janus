import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { GeminiInteractionSystem } from './scripts/gemini-interactions-system.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

const publicPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(publicPath));
// Fallback to serving the frontend folder for files not in dist (optional, for dev)
app.use(express.static(path.join(__dirname, '../../frontend')));

io.on('connection', (socket) => {
    // note the gemini driver seat handles the socket lifetime for a particular user
    new GeminiInteractionSystem(process.env.API_KEY || "", socket);

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
    console.log("Connected to socket.io");
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
