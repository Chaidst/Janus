const sessionsList = document.getElementById('sessions-list') as HTMLDivElement;
const messagesArea = document.getElementById('messages-area') as HTMLDivElement;
const transcriptArea = document.getElementById('transcript-area') as HTMLDivElement;
const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const welcomeScreen = document.getElementById('welcome-screen') as HTMLDivElement;
const currentViewTitle = document.getElementById('current-view-title') as HTMLHeadingElement;
const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement;

type ConversationMessage = { role: string, text: string };
type SessionMessage = { role: string, text: string };
type SessionDetails = {
    id: string;
    startedAt: number;
    summary?: string;
    messages?: SessionMessage[];
};

let conversationHistory: ConversationMessage[] = [];
let activeSummaryAudio: HTMLAudioElement | null = null;
let activeSummaryButton: HTMLButtonElement | null = null;
let summaryButtonResetTimer: number | null = null;

function escapeHtml(value: string) {
    const escapes: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    };

    return value.replace(/[&<>"']/g, character => escapes[character] || character);
}

function clearSummaryResetTimer() {
    if (summaryButtonResetTimer === null) {
        return;
    }

    window.clearTimeout(summaryButtonResetTimer);
    summaryButtonResetTimer = null;
}

function renderSummaryAudioButtonContent(state: 'idle' | 'loading' | 'playing' | 'failed') {
    switch (state) {
        case 'loading':
            return '<span class="summary-audio-spinner" aria-hidden="true"></span><span>Loading</span>';
        case 'playing':
            return '<span aria-hidden="true">⏹️</span><span>Stop</span>';
        case 'failed':
            return '<span aria-hidden="true">❌</span><span>Failed</span>';
        default:
            return '<span aria-hidden="true">🔊</span><span>Listen</span>';
    }
}

function setSummaryButtonState(button: HTMLButtonElement, state: 'idle' | 'loading' | 'playing' | 'failed') {
    button.classList.toggle('is-loading', state === 'loading');
    button.classList.toggle('is-playing', state === 'playing');
    button.classList.toggle('is-failed', state === 'failed');
    button.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
    button.innerHTML = renderSummaryAudioButtonContent(state);
}

function resetActiveSummaryButton() {
    if (!activeSummaryButton) {
        return;
    }

    setSummaryButtonState(activeSummaryButton, 'idle');
    activeSummaryButton = null;
}

function stopActiveSummaryPlayback() {
    clearSummaryResetTimer();

    if (activeSummaryAudio) {
        activeSummaryAudio.pause();
        activeSummaryAudio.src = '';
        activeSummaryAudio.load();
        activeSummaryAudio = null;
    }

    resetActiveSummaryButton();
}

function failActiveSummaryPlayback() {
    clearSummaryResetTimer();

    if (activeSummaryAudio) {
        activeSummaryAudio.pause();
        activeSummaryAudio.src = '';
        activeSummaryAudio.load();
        activeSummaryAudio = null;
    }

    if (!activeSummaryButton) {
        return;
    }

    const failedButton = activeSummaryButton;
    setSummaryButtonState(failedButton, 'failed');
    activeSummaryButton = null;
    summaryButtonResetTimer = window.setTimeout(() => {
        setSummaryButtonState(failedButton, 'idle');
        summaryButtonResetTimer = null;
    }, 1500);
}

async function handleSummaryAudio(button: HTMLButtonElement) {
    const sessionId = button.dataset.sessionAudioId;
    if (!sessionId) {
        return;
    }

    if (activeSummaryButton === button) {
        stopActiveSummaryPlayback();
        return;
    }

    stopActiveSummaryPlayback();
    setSummaryButtonState(button, 'loading');

    const audio = new Audio(`/api/sessions/${encodeURIComponent(sessionId)}/audio`);
    audio.preload = 'auto';
    activeSummaryAudio = audio;
    activeSummaryButton = button;

    audio.onloadeddata = () => {
        if (audio !== activeSummaryAudio || button !== activeSummaryButton) {
            return;
        }

        setSummaryButtonState(button, 'playing');
    };

    audio.onended = () => {
        if (audio !== activeSummaryAudio) {
            return;
        }

        stopActiveSummaryPlayback();
    };

    audio.onerror = () => {
        if (audio !== activeSummaryAudio) {
            return;
        }

        console.error('Failed to load summary audio.');
        failActiveSummaryPlayback();
    };

    try {
        await audio.play();
    } catch (error) {
        if (audio === activeSummaryAudio) {
            console.error('Failed to play summary audio:', error);
            failActiveSummaryPlayback();
        }
    }
}

function renderTranscript(session: SessionDetails) {
    const date = new Date(session.startedAt).toLocaleString();
    const summary = session.summary?.trim() || '';
    const summaryMarkup = summary ? escapeHtml(summary) : 'N/A';
    const messagesMarkup = session.messages && session.messages.length > 0
        ? session.messages.map((msg) => {
            const roleClass = msg.role === 'model' ? 'gemini' : 'child';
            const roleName = msg.role === 'model' ? 'Gemini' : 'Child';
            return `
                <div class="log-entry">
                    <div class="log-role ${roleClass}">${roleName}:</div>
                    <div class="log-text">${escapeHtml(msg.text || '')}</div>
                </div>
            `;
        }).join('')
        : '<p>No messages recorded.</p>';

    return `
        <div class="transcript-header">
            <h2>Session Transcript</h2>
            <p>Started: ${date}</p>
            <div class="transcript-summary">
                <div class="transcript-summary-header">
                    <strong>Summary</strong>
                    <button
                        type="button"
                        class="summary-audio-btn"
                        data-session-audio-id="${escapeHtml(session.id)}"
                        ${summary ? '' : 'disabled'}
                    >
                        ${renderSummaryAudioButtonContent('idle')}
                    </button>
                </div>
                <p class="summary-text">${summaryMarkup}</p>
            </div>
        </div>
        <div class="transcript-logs">
            ${messagesMarkup}
        </div>
    `;
}

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
    stopActiveSummaryPlayback();
    document.querySelectorAll('.session-item').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');

    welcomeScreen.classList.add('hidden');
    messagesArea.classList.add('hidden');
    transcriptArea.classList.remove('hidden');

    transcriptArea.innerHTML = '<div class="loading-spinner"></div>';
    currentViewTitle.textContent = "Session Transcript";

    try {
        const res = await fetch(`/api/sessions/${id}`);
        if (!res.ok) {
            throw new Error(`Failed to load session ${id}`);
        }

        const session = await res.json() as SessionDetails;
        transcriptArea.innerHTML = renderTranscript(session);

    } catch (e) {
        transcriptArea.innerHTML = `<p style="color: #ff8a8a;">Failed to load session details.</p>`;
    }
}

function startNewChat() {
    stopActiveSummaryPlayback();
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
                    } catch (e) { }
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

transcriptArea.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('.summary-audio-btn');
    if (!button || button.disabled) {
        return;
    }

    void handleSummaryAudio(button);
});

// Initial load
loadSessions();
