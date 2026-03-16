const sessionRoot = document.getElementById("session-root") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const assistantDock = document.getElementById(
  "assistant-dock",
) as HTMLDivElement;
const assistantThread = document.getElementById(
  "assistant-thread",
) as HTMLDivElement;
const assistantCloseButton = document.getElementById(
  "assistant-close-button",
) as HTMLButtonElement;
const clipModal = document.getElementById("clip-modal") as HTMLDivElement;
const profileMenuButton = document.getElementById(
  "profile-menu-button",
) as HTMLButtonElement;
const profileMenu = document.getElementById("profile-menu") as HTMLDivElement;

type ConversationMessage = { role: "user" | "model"; text: string };
type SessionMessage = {
  role: string;
  text: string;
  timestamp?: number;
};
type SessionActivity = {
  type: string;
  title: string;
  detail: string;
  timestamp: number;
};
type SessionDetails = {
  id: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  messages?: SessionMessage[];
  activities?: SessionActivity[];
  childName?: string;
  messageCount?: number;
  alertCount?: number;
  alerts?: SessionAlert[];
};
type SessionListItem = {
  id: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  childName?: string;
  messageCount?: number;
  alertCount?: number;
  messages?: SessionMessage[];
};
type AlertKind = "distress" | "safety";
type ViewMode = "all" | "alerts";
type SessionAlert = {
  id: string;
  kind: AlertKind;
  title: string;
  label: string;
  summary: string;
  messageIndex: number;
  timestamp: number;
  clipDuration: string;
  clipStatus: string;
  excerpt?: string;
  expanded: boolean;
};

let activeSession: SessionDetails | null = null;
let sessionList: SessionListItem[] = [];
let activeAlerts: SessionAlert[] = [];
let activeView: ViewMode = "all";
let conversationHistory: ConversationMessage[] = [];
let currentClipAlertId: string | null = null;
let clipPlaybackActive = false;
let overlaySyncFrame: number | null = null;
let activeSessionId: string | null = null;
let loadingSessionId: string | null = null;
let sessionLoadError: string | null = null;
let showMobileDetail = false;

function escapeHtml(value: string) {
  const escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  return value.replace(
    /[&<>"']/g,
    (character) => escapes[character] || character,
  );
}

function childNameForSession(session: { childName?: string }) {
  if (typeof session.childName === "string" && session.childName.trim()) {
    return session.childName.trim();
  }

  return "Emma";
}

function childInitialForSession(session: { childName?: string }) {
  return childNameForSession(session).trim().charAt(0).toUpperCase() || "E";
}

function isSessionLive(session: { endedAt?: number }) {
  return typeof session.endedAt !== "number";
}

function formatClock(timestamp?: number) {
  if (!timestamp) {
    return "";
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatStartLabel(startedAt: number) {
  return `Session started ${formatClock(startedAt)}`;
}

function formatSessionDate(timestamp: number) {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function messageCountForSession(session: {
  messages?: SessionMessage[];
  messageCount?: number;
}) {
  if (typeof session.messageCount === "number") {
    return session.messageCount;
  }

  return Array.isArray(session.messages) ? session.messages.length : 0;
}

function alertCountForSession(session: { alertCount?: number }) {
  if (typeof session.alertCount === "number") {
    return session.alertCount;
  }

  return 0;
}

function computeDurationLabel(session: {
  startedAt: number;
  endedAt?: number;
  messages?: SessionMessage[];
  messageCount?: number;
}) {
  const messages = session.messages || [];
  const timestamps = messages
    .map((message) => message.timestamp)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );

  if (timestamps.length >= 2) {
    const minutes = Math.max(
      1,
      Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 60000),
    );
    return `${minutes} min`;
  }

  if (
    typeof session.endedAt === "number" &&
    session.endedAt > session.startedAt
  ) {
    const minutes = Math.max(
      1,
      Math.round((session.endedAt - session.startedAt) / 60000),
    );
    return `${minutes} min`;
  }

  const fallbackMinutes = Math.max(6, messageCountForSession(session) * 2 - 2);
  return `${fallbackMinutes} min`;
}

function sessionPreview(session: Pick<SessionListItem, "summary">) {
  if (typeof session.summary === "string" && session.summary.trim()) {
    return session.summary.trim();
  }

  return "Full conversation transcript available for review.";
}

function historyDateCopy(
  session: Pick<SessionListItem, "startedAt" | "endedAt">,
) {
  if (isSessionLive(session)) {
    return `Started ${formatClock(session.startedAt)}`;
  }

  return formatSessionDate(session.startedAt);
}

function sessionHeadline(session: SessionListItem) {
  if (isSessionLive(session)) {
    return "Live session";
  }

  return `Chat from ${new Date(session.startedAt).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function choosePreferredSession(sessions: SessionListItem[]) {
  return (
    sessions.find((session) => isSessionLive(session)) ||
    sessions.find((session) => messageCountForSession(session) > 0) ||
    sessions.find(
      (session) =>
        typeof session.summary === "string" &&
        session.summary.trim().length > 0,
    ) ||
    sessions[0]
  );
}

function normalizeAlerts(alerts: SessionDetails["alerts"]) {
  if (!Array.isArray(alerts)) {
    return [];
  }

  return alerts.map((alert) => ({
    ...alert,
    expanded: true,
  }));
}

function getMessageAlertKind(index: number) {
  const alert = activeAlerts.find((entry) => entry.messageIndex === index);
  return alert?.kind || null;
}

function iconMessage() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 17L3 20V7.5C3 6.11929 4.11929 5 5.5 5H18.5C19.8807 5 21 6.11929 21 7.5V14.5C21 15.8807 19.8807 17 18.5 17H7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
  `;
}

function iconAlert() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4L21 19H3L12 4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M12 9.5V13.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M12 17H12.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    </svg>
  `;
}

function iconClock() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.8"/>
      <path d="M12 7.5V12L15.5 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

function iconSparkle() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3L13.9 8.1L19 10L13.9 11.9L12 17L10.1 11.9L5 10L10.1 8.1L12 3Z" fill="currentColor"/>
      <path d="M18 15L18.9 17.1L21 18L18.9 18.9L18 21L17.1 18.9L15 18L17.1 17.1L18 15Z" fill="currentColor"/>
    </svg>
  `;
}

function iconPlay() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 6.5L18 12L8 17.5V6.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
  `;
}

function iconChevronUp() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 14L12 9L17 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

function iconSkipBack() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8.5 12L18 6.5V17.5L8.5 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M6 6.5V17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `;
}

function iconSkipForward() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15.5 12L6 6.5V17.5L15.5 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M18 6.5V17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `;
}

function iconVolume() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 10H9.5L13.5 6V18L9.5 14H6V10Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M16.5 9C17.4298 9.73729 18 10.8327 18 12C18 13.1673 17.4298 14.2627 16.5 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `;
}

function iconExpand() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14 5H19V10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M19 5L13 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M10 19H5V14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5 19L11 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `;
}

function iconDismiss() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `;
}

function renderSessionSummary(session: SessionDetails) {
  const messages = session.messages || [];
  const alertsCount = activeAlerts.length;
  const childName = childNameForSession(session);
  const live = isSessionLive(session);

  return `
    <section class="session-summary-card">
      <div class="session-summary-main">
        <div class="session-summary-profile">
          <div class="session-avatar" aria-hidden="true">
            <span>👧</span>
            <span class="session-avatar-status"></span>
          </div>

          <div>
            <div class="session-child-name">
              <span>${escapeHtml(childName)}</span>
              <span class="session-state-pill ${live ? "is-live" : "is-ended"}">${live ? "Active" : "Ended"}</span>
            </div>
            <div class="session-meta-copy">${formatStartLabel(session.startedAt)} • ${computeDurationLabel(session)}</div>
          </div>
        </div>
      </div>

      <div class="session-summary-divider"></div>

      <div class="session-stat-row">
        <div class="session-stat">
          ${iconMessage()}
          <span>${messages.length} messages</span>
        </div>
        <div class="session-stat-divider" aria-hidden="true"></div>
        <div class="session-stat is-alert">
          ${iconAlert()}
          <span>${alertsCount} alerts</span>
        </div>
        <div class="session-stat-divider" aria-hidden="true"></div>
        <div class="session-stat">
          ${iconClock()}
          <span>${computeDurationLabel(session)} session</span>
        </div>
      </div>
    </section>
  `;
}

function renderTabs() {
  return `
    <nav class="session-tabs" aria-label="Session views">
      <button type="button" class="tab-button ${activeView === "all" ? "is-active" : ""}" data-view-mode="all">
        <span>All Messages</span>
      </button>
      <button type="button" class="tab-button is-alert ${activeView === "alerts" ? "is-active" : ""}" data-view-mode="alerts">
        ${iconAlert()}
        <span>Alerts</span>
        <span class="tab-count">${activeAlerts.length}</span>
      </button>
    </nav>
  `;
}

function renderMessage(message: SessionMessage, index: number) {
  const role = message.role === "model" ? "model" : "child";
  const alertKind = getMessageAlertKind(index);
  const alertClass = alertKind ? ` is-${alertKind}` : "";
  const content = escapeHtml(message.text || "");
  const timestamp = formatClock(message.timestamp || activeSession?.startedAt);
  const childInitial = activeSession
    ? childInitialForSession(activeSession)
    : "E";

  if (role === "model") {
    return `
      <div class="timeline-row model-row" data-message-index="${index}">
        <div class="timeline-avatar janus-avatar" aria-hidden="true">
          ${iconSparkle()}
        </div>
        <div class="timeline-content">
          <div class="message-shell">
            <div class="message-bubble">${content}</div>
          </div>
          <div class="message-meta">${timestamp}</div>
        </div>
      </div>
    `;
  }

  return `
    <div class="timeline-row child-row" data-message-index="${index}">
      <div class="timeline-content">
        <div class="message-shell">
          <div class="message-bubble${alertClass}">${content}</div>
          <div class="timeline-avatar message-avatar" aria-hidden="true">${childInitial}</div>
        </div>
        <div class="message-meta">${timestamp}</div>
      </div>
    </div>
  `;
}

function renderAlertBanner(alert: SessionAlert, overlay = false) {
  return `
    <article class="alert-banner is-${alert.kind} ${overlay ? "is-overlay" : ""} ${alert.expanded ? "is-expanded" : "is-collapsed"}" data-alert-id="${alert.id}">
      <div class="alert-banner-header">
        <div class="alert-banner-title-wrap">
          <div class="alert-banner-icon">${iconAlert()}</div>
          <div class="alert-banner-copy">
            <span class="alert-banner-title">${alert.title}</span>
            <span class="alert-banner-label">${alert.label}</span>
          </div>
        </div>

        <div class="alert-banner-actions">
          <button type="button" class="clip-trigger" data-open-clip="${alert.id}">
            ${iconPlay()}
            <span>Clip</span>
          </button>
          <button type="button" class="alert-toggle-button" data-toggle-alert="${alert.id}" aria-expanded="${alert.expanded ? "true" : "false"}" aria-label="Toggle alert details">
            ${iconChevronUp()}
          </button>
        </div>
      </div>
      <p class="alert-summary">${escapeHtml(alert.summary)}</p>
    </article>
  `;
}

function renderAllMessagesView(session: SessionDetails) {
  const messages = session.messages || [];

  return `
    <div class="conversation-stage" id="conversation-stage">
      <div class="timeline-items">
        ${messages.map((message, index) => renderMessage(message, index)).join("")}
      </div>
      <div class="timeline-overlays" id="timeline-overlays">
        ${activeAlerts.map((alert) => renderAlertBanner(alert, true)).join("")}
      </div>
    </div>
  `;
}

function renderAlertsView(session: SessionDetails) {
  const messages = session.messages || [];

  if (activeAlerts.length === 0) {
    return `<div class="no-alerts-card">No alerts were detected for this session yet.</div>`;
  }

  const sections = activeAlerts.map((alert) => {
    const startIndex = Math.max(0, alert.messageIndex - 1);
    const endIndex = Math.min(messages.length - 1, alert.messageIndex + 1);
    const relevantMessages = messages
      .slice(startIndex, endIndex + 1)
      .map((message, relativeIndex) =>
        renderMessage(message, startIndex + relativeIndex),
      )
      .join("");

    return `
      <section class="alert-thread-section">
        ${renderAlertBanner(alert)}
        <div class="alert-thread-messages">${relevantMessages}</div>
      </section>
    `;
  });

  return `<div class="alerts-feed">${sections.join("")}</div>`;
}

function renderHistoryPanel() {
  const childName = childNameForSession(activeSession || sessionList[0] || {});

  return `
    <aside class="session-history-panel" aria-label="Session history">
      <div class="session-history-header">
        <div>
          <div class="session-history-eyebrow">Chats</div>
          <h2 class="session-history-title">${escapeHtml(childName)}'s history</h2>
        </div>
        <div class="session-history-count">${sessionList.length}</div>
      </div>
      <p class="session-history-subtitle">Review previous chats without replacing the live session on open.</p>
      <div class="session-history-list">
        ${sessionList
          .map((session) => {
            const isSelected = activeSessionId === session.id;
            const isLoading = loadingSessionId === session.id;
            const live = isSessionLive(session);

            return `
              <button
                type="button"
                class="session-history-item ${isSelected ? "is-active" : ""} ${isLoading ? "is-loading" : ""}"
                data-session-id="${escapeHtml(session.id)}"
                ${isLoading ? "disabled" : ""}
              >
                <div class="session-history-item-top">
                  <div class="session-history-avatar" aria-hidden="true">${childInitialForSession(session)}</div>
                  <div class="session-history-item-copy">
                    <div class="session-history-item-title-row">
                      <span class="session-history-item-title">${escapeHtml(sessionHeadline(session))}</span>
                      <span class="session-history-status ${live ? "is-live" : "is-ended"}">${live ? "Live" : "Past"}</span>
                    </div>
                    <div class="session-history-item-date">${historyDateCopy(session)}</div>
                  </div>
                </div>
                <p class="session-history-preview">${escapeHtml(sessionPreview(session))}</p>
                <div class="session-history-meta">
                  <span>${messageCountForSession(session)} messages</span>
                  <span>${alertCountForSession(session)} alerts</span>
                  <span>${computeDurationLabel(session)}</span>
                </div>
              </button>
            `;
          })
          .join("")}
      </div>
    </aside>
  `;
}

function renderSessionWorkspace() {
  if (loadingSessionId && !activeSession) {
    return `
      <div class="session-detail-empty">
        <div class="loading-spinner"></div>
        <p>Loading session…</p>
      </div>
    `;
  }

  if (!activeSession) {
    return `
      <div class="session-detail-empty">
        <p>${escapeHtml(sessionLoadError || "Select a chat to review the conversation.")}</p>
      </div>
    `;
  }

  return `
    <div class="session-detail-shell ${loadingSessionId ? "is-loading" : ""}">
      <button type="button" class="mobile-back-button" data-mobile-back aria-label="Back to chat history">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Back to history</span>
      </button>
      ${renderSessionSummary(activeSession)}
      ${renderTabs()}
      <section class="conversation-frame">
        ${activeView === "all" ? renderAllMessagesView(activeSession) : renderAlertsView(activeSession)}
      </section>
    </div>
  `;
}

function renderActiveSession() {
  if (sessionList.length === 0 && !activeSession) {
    sessionRoot.innerHTML = `
      <div class="empty-state">
        <p>No sessions available yet.</p>
      </div>
    `;
    return;
  }

  const mobileDetailClass = showMobileDetail ? "mobile-show-detail" : "";

  sessionRoot.innerHTML = `
    <div class="session-layout ${mobileDetailClass}">
      ${renderHistoryPanel()}
      <section class="session-detail-panel">
        ${renderSessionWorkspace()}
      </section>
    </div>
  `;

  if (activeSession) {
    window.requestAnimationFrame(syncAlertOverlayPositions);
  }
}

function renderAssistantDock() {
  if (conversationHistory.length === 0) {
    assistantDock.classList.add("hidden");
    assistantThread.innerHTML = "";
    return;
  }

  assistantDock.classList.remove("hidden");
  assistantThread.innerHTML = conversationHistory
    .map((message) => {
      const roleClass = message.role === "user" ? "parent" : "gemini";
      return `<div class="assistant-bubble ${roleClass}">${escapeHtml(message.text)}</div>`;
    })
    .join("");
  assistantThread.scrollTop = assistantThread.scrollHeight;
}

function renderLoadingAssistantBubble() {
  assistantDock.classList.remove("hidden");
  assistantThread.insertAdjacentHTML(
    "beforeend",
    `<div class="assistant-bubble gemini is-loading" data-loading-bubble="true"><div class="loading-spinner"></div><span>Gemini is thinking…</span></div>`,
  );
  assistantThread.scrollTop = assistantThread.scrollHeight;
}

function renderClipModal() {
  const activeAlert = activeAlerts.find(
    (alert) => alert.id === currentClipAlertId,
  );

  if (!activeAlert) {
    clipModal.classList.add("hidden");
    clipModal.setAttribute("aria-hidden", "true");
    clipModal.innerHTML = "";
    document.body.classList.remove("modal-open");
    return;
  }

  const modalTitle = `${activeAlert.title} — ${formatClock(activeAlert.timestamp)}`;

  clipModal.classList.remove("hidden");
  clipModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  clipModal.innerHTML = `
    <div class="clip-dialog is-${activeAlert.kind}" role="dialog" aria-modal="true" aria-label="${escapeHtml(modalTitle)}">
      <div class="clip-dialog-inner">
        <div class="clip-dialog-header">
          <div class="clip-dialog-title-wrap">
            ${iconAlert()}
            <div class="clip-dialog-title">${escapeHtml(modalTitle)}</div>
          </div>
          <button type="button" class="clip-dismiss-button" data-close-clip aria-label="Close clip">
            ${iconDismiss()}
          </button>
        </div>

        <div class="clip-player-shell">
          <div class="clip-poster is-${activeAlert.kind}">
            <div class="clip-poster-stage">
              <div class="clip-figure" aria-hidden="true"></div>
            </div>
            <div class="clip-play-surface">
              <button type="button" class="clip-play-button" data-toggle-clip-play aria-label="${clipPlaybackActive ? "Pause clip" : "Play clip"}">
                ${iconPlay()}
              </button>
            </div>
            <div class="clip-status-pill">${escapeHtml(activeAlert.clipStatus)}</div>
            <div class="clip-duration-pill">${activeAlert.clipDuration}</div>
          </div>

          <div class="clip-progress-track" style="--clip-progress: ${clipPlaybackActive ? "61%" : "34%"};"></div>

          <div class="clip-timeline-pills">
            <div class="clip-timeline-pill is-active">0:00</div>
            <div class="clip-timeline-pill">0:22</div>
            <div class="clip-timeline-pill">${activeAlert.kind === "safety" ? "0:31" : "0:48"}</div>
          </div>

          <div class="clip-controls">
            <div class="clip-controls-left">
              <button type="button" class="clip-control-button" aria-label="Previous">${iconSkipBack()}</button>
              <button type="button" class="clip-control-button" data-toggle-clip-play aria-label="${clipPlaybackActive ? "Pause clip" : "Play clip"}">${iconPlay()}</button>
              <button type="button" class="clip-control-button" aria-label="Next">${iconSkipForward()}</button>
            </div>
            <div class="clip-controls-right">
              <button type="button" class="clip-control-button" aria-label="Volume">${iconVolume()}</button>
              <button type="button" class="clip-control-button" aria-label="Expand">${iconExpand()}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function syncAlertOverlayPositions() {
  if (overlaySyncFrame !== null) {
    window.cancelAnimationFrame(overlaySyncFrame);
  }

  overlaySyncFrame = window.requestAnimationFrame(() => {
    overlaySyncFrame = null;

    if (activeView !== "all") {
      return;
    }

    const stage = document.getElementById("conversation-stage");
    if (!stage) {
      return;
    }

    let previousBottom = 0;
    activeAlerts.forEach((alert) => {
      const alertNode = stage.querySelector<HTMLElement>(
        `[data-alert-id="${alert.id}"]`,
      );
      const anchorNode = stage.querySelector<HTMLElement>(
        `[data-message-index="${alert.messageIndex}"]`,
      );
      if (!alertNode || !anchorNode) {
        return;
      }

      const alertHeight = alertNode.offsetHeight;
      const desiredTop = Math.max(12, anchorNode.offsetTop - alertHeight - 14);
      const top = Math.max(desiredTop, previousBottom + 18);
      alertNode.style.top = `${top}px`;
      previousBottom = top + alertHeight;
    });
  });
}

function setActiveView(nextView: ViewMode) {
  if (activeView === nextView) {
    return;
  }

  activeView = nextView;
  renderActiveSession();
}

function toggleAlertExpansion(alertId: string) {
  const targetAlert = activeAlerts.find((alert) => alert.id === alertId);
  if (!targetAlert) {
    return;
  }

  targetAlert.expanded = !targetAlert.expanded;
  renderActiveSession();
}

function openClip(alertId: string) {
  currentClipAlertId = alertId;
  clipPlaybackActive = false;
  renderClipModal();
}

function closeClip() {
  currentClipAlertId = null;
  clipPlaybackActive = false;
  renderClipModal();
}

function toggleClipPlayback() {
  if (!currentClipAlertId) {
    return;
  }

  clipPlaybackActive = !clipPlaybackActive;
  renderClipModal();
}

async function loadLatestSession() {
  try {
    const response = await fetch("/api/sessions");
    if (!response.ok) {
      throw new Error("Failed to load sessions");
    }

    const sessions = (await response.json()) as SessionListItem[];
    if (!Array.isArray(sessions) || sessions.length === 0) {
      sessionList = [];
      activeSession = null;
      activeSessionId = null;
      activeAlerts = [];
      sessionLoadError = null;
      renderActiveSession();
      return;
    }

    const preferredSession = choosePreferredSession(sessions);
    sessionList = sessions;
    sessionLoadError = null;
    loadingSessionId = preferredSession.id;
    renderActiveSession();

    const sessionResponse = await fetch(
      `/api/sessions/${encodeURIComponent(preferredSession.id)}`,
    );
    if (!sessionResponse.ok) {
      throw new Error(`Failed to load session ${preferredSession.id}`);
    }

    activeSession = (await sessionResponse.json()) as SessionDetails;
    activeSessionId = activeSession.id;
    activeAlerts = normalizeAlerts(activeSession.alerts);
    activeView = "all";
    loadingSessionId = null;
    if (window.innerWidth <= 780) {
      showMobileDetail = true;
    }
    renderActiveSession();
  } catch (error) {
    console.error("Failed to load latest session:", error);
    loadingSessionId = null;
    sessionLoadError = "Failed to load the parent session view.";
    activeSession = null;
    activeSessionId = null;
    activeAlerts = [];
    renderActiveSession();
  }
}

async function loadSession(sessionId: string) {
  if (
    !sessionId ||
    sessionId === activeSessionId ||
    sessionId === loadingSessionId
  ) {
    return;
  }

  try {
    loadingSessionId = sessionId;
    sessionLoadError = null;
    currentClipAlertId = null;
    clipPlaybackActive = false;
    renderClipModal();
    renderActiveSession();

    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to load session ${sessionId}`);
    }

    activeSession = (await response.json()) as SessionDetails;
    activeSessionId = activeSession.id;
    activeAlerts = normalizeAlerts(activeSession.alerts);
    activeView = "all";
    if (window.innerWidth <= 780) {
      showMobileDetail = true;
    }
  } catch (error) {
    console.error("Failed to load selected session:", error);
    sessionLoadError = "Failed to load that chat. Please try again.";
  } finally {
    loadingSessionId = null;
    renderActiveSession();
  }
}

function hideMobileDetailView() {
  showMobileDetail = false;
  renderActiveSession();
}

function updateComposerState() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${chatInput.scrollHeight}px`;
  sendBtn.disabled = chatInput.value.trim() === "";
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) {
    return;
  }

  conversationHistory.push({ role: "user", text });
  renderAssistantDock();
  renderLoadingAssistantBubble();

  chatInput.value = "";
  updateComposerState();

  try {
    const response = await fetch("/api/parent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        conversationHistory,
      }),
    });

    if (!response.body) {
      throw new Error("No readable stream");
    }

    const loadingBubble = assistantThread.querySelector<HTMLElement>(
      '[data-loading-bubble="true"]',
    );
    const replyBubble = document.createElement("div");
    replyBubble.className = "assistant-bubble gemini";
    if (loadingBubble) {
      loadingBubble.replaceWith(replyBubble);
    } else {
      assistantThread.appendChild(replyBubble);
    }

    let fullResponse = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") {
          continue;
        }

        try {
          const data = JSON.parse(line.slice(6));
          if (typeof data.text === "string") {
            fullResponse += data.text;
            replyBubble.textContent = fullResponse;
            assistantThread.scrollTop = assistantThread.scrollHeight;
          }
        } catch (error) {
          console.error("Failed to parse parent chat stream chunk:", error);
        }
      }
    }

    conversationHistory.push({ role: "model", text: fullResponse });
    renderAssistantDock();
  } catch (error) {
    console.error("Failed to send parent chat message:", error);
    const loadingBubble = assistantThread.querySelector<HTMLElement>(
      '[data-loading-bubble="true"]',
    );
    if (loadingBubble) {
      loadingBubble.outerHTML = `<div class="assistant-bubble gemini">Gemini could not answer right now.</div>`;
    }
  }
}

chatInput.addEventListener("input", updateComposerState);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});
sendBtn.addEventListener("click", () => {
  void sendMessage();
});

assistantCloseButton.addEventListener("click", () => {
  assistantDock.classList.add("hidden");
});

profileMenuButton.addEventListener("click", () => {
  const isOpen = !profileMenu.classList.contains("hidden");
  profileMenu.classList.toggle("hidden", isOpen);
  profileMenuButton.setAttribute("aria-expanded", isOpen ? "false" : "true");
});

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;

  if (!profileMenu.contains(target) && !profileMenuButton.contains(target)) {
    profileMenu.classList.add("hidden");
    profileMenuButton.setAttribute("aria-expanded", "false");
  }

  const viewButton = target.closest<HTMLElement>("[data-view-mode]");
  if (viewButton) {
    const viewMode =
      viewButton.dataset.viewMode === "alerts" ? "alerts" : "all";
    setActiveView(viewMode);
    return;
  }

  const historyButton = target.closest<HTMLElement>("[data-session-id]");
  if (historyButton?.dataset.sessionId) {
    void loadSession(historyButton.dataset.sessionId);
    return;
  }

  const backButton = target.closest<HTMLElement>("[data-mobile-back]");
  if (backButton) {
    hideMobileDetailView();
    return;
  }

  const toggleButton = target.closest<HTMLElement>("[data-toggle-alert]");
  if (toggleButton?.dataset.toggleAlert) {
    toggleAlertExpansion(toggleButton.dataset.toggleAlert);
    return;
  }

  const clipButton = target.closest<HTMLElement>("[data-open-clip]");
  if (clipButton?.dataset.openClip) {
    openClip(clipButton.dataset.openClip);
    return;
  }

  if (target.closest("[data-close-clip]")) {
    closeClip();
    return;
  }

  if (target.closest("[data-toggle-clip-play]")) {
    toggleClipPlayback();
  }
});

clipModal.addEventListener("click", (event) => {
  if (event.target === clipModal) {
    closeClip();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!clipModal.classList.contains("hidden")) {
      closeClip();
      return;
    }

    if (!profileMenu.classList.contains("hidden")) {
      profileMenu.classList.add("hidden");
      profileMenuButton.setAttribute("aria-expanded", "false");
    }
  }
});

window.addEventListener("resize", () => {
  syncAlertOverlayPositions();
});

updateComposerState();
void loadLatestSession();
