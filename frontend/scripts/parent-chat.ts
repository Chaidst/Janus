const sessionsList = document.getElementById('sessions-list') as HTMLDivElement;
const messagesArea = document.getElementById('messages-area') as HTMLDivElement;
const transcriptArea = document.getElementById('transcript-area') as HTMLDivElement;
const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const welcomeScreen = document.getElementById('welcome-screen') as HTMLDivElement;
const currentViewTitle = document.getElementById('current-view-title') as HTMLHeadingElement;
const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement;

let conversationHistory: {role: string, text: string}[] = [];

async function loadSessions() {
    try {
        const response = await fetch('/api/sessions');
        const sessions = await response.json();
        
        sessionsList.innerHTML = '';
        if (sessions.length === 0) {
            sessionsList.innerHTML = '<div style="color: var(--text-secondary); font-size: 13px; padding: 12px;">No sessions yet.</div>';
            return;
        }

        sessions.forEach((session: any) => {
            const item = document.createElement('div');
            item.className = 'session-item';
            const date = new Date(session.startedAt).toLocaleString();
            item.innerHTML = `
                <div class="session-time">${date}</div>
                <div class="session-preview">${session.summary || 'No summary yet'}</div>
            `;
            item.onclick = () => viewSession(session.id, item);
            sessionsList.appendChild(item);
        });
    } catch (error) {
        console.error("Failed to load sessions:", error);
        sessionsList.innerHTML = '<div style="color: #ff8a8a; font-size: 13px; padding: 12px;">Failed to load sessions.</div>';
    }
}

async function viewSession(id: string, element: HTMLElement) {
    document.querySelectorAll('.session-item').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');
    
    welcomeScreen.classList.add('hidden');
    messagesArea.classList.add('hidden');
    transcriptArea.classList.remove('hidden');
    
    transcriptArea.innerHTML = '<div class="loading-spinner"></div>';
    currentViewTitle.textContent = "Session Transcript";
    
    try {
        const res = await fetch(`/api/sessions/${id}`);
        const session = await res.json();
        
        const date = new Date(session.startedAt).toLocaleString();
        let html = `
            <div class="transcript-header">
                <h2>Session Transcript</h2>
                <p>Started: ${date}</p>
                <p><strong>Summary:</strong> ${session.summary || 'N/A'}</p>
            </div>
            <div class="transcript-logs">
        `;
        
        if (session.messages && session.messages.length > 0) {
            session.messages.forEach((msg: any) => {
                const roleClass = msg.role === 'model' ? 'gemini' : 'child';
                const roleName = msg.role === 'model' ? 'Gemini' : 'Child';
                html += `
                    <div class="log-entry">
                        <div class="log-role ${roleClass}">${roleName}:</div>
                        <div class="log-text">${msg.text}</div>
                    </div>
                `;
            });
        } else {
            html += `<p>No messages recorded.</p>`;
        }
        
        html += `</div>`;
        transcriptArea.innerHTML = html;
        
    } catch (e) {
        transcriptArea.innerHTML = `<p style="color: #ff8a8a;">Failed to load session details.</p>`;
    }
}

function startNewChat() {
    document.querySelectorAll('.session-item').forEach(el => el.classList.remove('selected'));
    currentViewTitle.textContent = "Chat with Gemini";
    transcriptArea.classList.add('hidden');
    
    if (conversationHistory.length === 0) {
        welcomeScreen.classList.remove('hidden');
        messagesArea.classList.add('hidden');
    } else {
        welcomeScreen.classList.add('hidden');
        messagesArea.classList.remove('hidden');
    }
}

if (newChatBtn) newChatBtn.onclick = startNewChat;

// Chat UI sizing
if (chatInput) {
    chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = (chatInput.scrollHeight) + 'px';
        if (sendBtn) sendBtn.disabled = chatInput.value.trim() === '';
    });
}

// Chat submission
async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    
    // Switch to chat view if not already
    startNewChat();
    welcomeScreen.classList.add('hidden');
    messagesArea.classList.remove('hidden');
    
    // Add user message to UI
    appendMessage('user', text);
    chatInput.value = '';
    chatInput.style.height = 'auto';
    sendBtn.disabled = true;
    
    // Create placeholder for Gemini response
    const modelBubble = appendMessage('model', '<div class="loading-spinner" style="margin: 0; width: 16px; height: 16px; border-width: 2px;"></div>');
    const textElement = modelBubble.querySelector('.model-text') as HTMLDivElement;
    
    try {
        const response = await fetch('/api/parent/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: text,
                conversationHistory
            })
        });
        
        if (!response.body) throw new Error('No readable stream');
        
        conversationHistory.push({ role: 'user', text });
        
        textElement.innerHTML = '';
        let fullResponse = '';
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(line.substring(6));
                        if (data.text) {
                            fullResponse += data.text;
                            // Basic markdown-to-html for linebreaks and bold
                            let htmlResponse = fullResponse
                                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                                .replace(/\n/g, '<br>');
                            textElement.innerHTML = htmlResponse;
                            scrollToBottom();
                        }
                    } catch(e) {}
                }
            }
        }
        
        conversationHistory.push({ role: 'model', text: fullResponse });
        
    } catch (e) {
        textElement.innerHTML = `<span style="color: #ff8a8a;">Error connecting to Gemini.</span>`;
    }
}

function appendMessage(role: string, content: string) {
    const row = document.createElement('div');
    row.className = `message-row ${role}-row`;
    
    if (role === 'user') {
        row.innerHTML = `<div class="message-bubble">${content}</div>`;
    } else {
        row.innerHTML = `
            <div class="message-bubble">
                <div class="model-icon">✨</div>
                <div class="model-text">${content}</div>
            </div>
        `;
    }
    
    messagesArea.appendChild(row);
    scrollToBottom();
    return row;
}

function scrollToBottom() {
    const chatContainer = document.getElementById('chat-container');
    if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }
}

if (sendBtn) sendBtn.onclick = sendMessage;
if (chatInput) {
    chatInput.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };
}

// Initial load
loadSessions();
