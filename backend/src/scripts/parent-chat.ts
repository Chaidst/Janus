import type { Express } from 'express';
import { db } from './firebase.js';
import { GoogleGenAI } from '@google/genai';

const AI = new GoogleGenAI({apiKey: process.env.API_KEY || "", httpOptions: {"apiVersion": "v1alpha"}});

export function setupParentChatRoutes(app: Express) {
    // Get all sessions
    app.get('/api/sessions', async (req, res) => {
        try {
            const sessionsSnapshot = await db.collection('families').doc('default').collection('children').doc('default').collection('sessions')
                .orderBy('startedAt', 'desc')
                .get();
                
            const sessions = sessionsSnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                messages: undefined // Don't send full history in list view
            }));
            
            res.json(sessions);
        } catch (error) {
            console.error('Error fetching sessions:', error);
            res.status(500).json({ error: 'Failed to fetch sessions' });
        }
    });

    // Get specific session details
    app.get('/api/sessions/:id', async (req, res) => {
        try {
            const sessionDoc = await db.collection('families').doc('default').collection('children').doc('default').collection('sessions').doc(req.params.id).get();
            
            if (!sessionDoc.exists) {
                res.status(404).json({ error: 'Session not found' });
                return;
            }
            
            res.json({
                id: sessionDoc.id,
                ...sessionDoc.data()
            });
        } catch (error) {
            console.error('Error fetching session:', error);
            res.status(500).json({ error: 'Failed to fetch session' });
        }
    });

    // Parent chat
    app.post('/api/parent/chat', async (req, res) => {
        const { message, conversationHistory } = req.body;
        
        if (!message) {
            res.status(400).json({ error: 'Message is required' });
            return;
        }

        try {
            // Fetch the last 5 sessions to provide context
            const sessionsSnapshot = await db.collection('families').doc('default').collection('children').doc('default').collection('sessions')
                .orderBy('startedAt', 'desc')
                .limit(5)
                .get();
                
            let contextText = "Here are the recent conversations between the child and their AI companion:\n\n";
            sessionsSnapshot.forEach(doc => {
                const data = doc.data();
                const startedAt = new Date(data.startedAt).toLocaleString();
                contextText += `--- Session from ${startedAt} ---\n`;
                contextText += `Summary: ${data.summary}\n`;
                contextText += `Transcript:\n`;
                (data.messages || []).forEach((msg: any) => {
                    contextText += `${msg.role}: ${msg.text}\n`;
                });
                contextText += `\n`;
            });

            const systemPrompt = `You are an AI assistant for parents, helping them monitor and understand their child's interactions with an AI companion.
You have access to the transcripts of the child's recent sessions. 
Be helpful, analytical, and reassuring. Answer the parent's questions about what the child has been learning, inquiring about, or doing, based strictly on the provided session context.
Always maintain a supportive and constructive tone. If the parent asks something outside the scope of the transcripts, politely mention that you only have access to the recent session history.

${contextText}`;

            // Create a chat session to maintain history
            const chat = AI.chats.create({
                model: 'gemini-2.5-flash',
                config: {
                    systemInstruction: { parts: [{ text: systemPrompt }] }
                }
            });

            // Send previous history if any to restore chat state
            if (conversationHistory && Array.isArray(conversationHistory)) {
                for (const msg of conversationHistory) {
                    // Just to build history locally in this request execution
                    // The Gemini SDK allows passing history to create() but we can also just send it all
                }
            }

            // Instead of manually reconstructing history, let's just make sure we send the latest message
            // Wait, setting up history via config or simple content array is better. Let's make it simpler:
            
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            let history = (conversationHistory || []).map((msg: any) => {
                return {
                    role: msg.role === 'model' ? 'model' : 'user',
                    parts: [{ text: msg.text }]
                };
            });
            
            // Add the new message
            history.push({ role: 'user', parts: [{ text: message }] });

            const responseStream = await AI.models.generateContentStream({
                model: 'gemini-2.5-flash',
                contents: history,
                config: {
                    systemInstruction: { parts: [{ text: systemPrompt }] }
                }
            });

            for await (const chunk of responseStream) {
                if (chunk.text) {
                    res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
                }
            }
            
            res.write('data: [DONE]\n\n');
            res.end();

        } catch (error) {
            console.error('Error in parent chat:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to process chat response' });
            } else {
                res.write(`data: ${JSON.stringify({ error: 'Failed to process chat response' })}\n\n`);
                res.end();
            }
        }
    });
}
