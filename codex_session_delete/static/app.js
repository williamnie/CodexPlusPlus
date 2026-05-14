/* Codex++ Remote Desktop Client */
(function () {
  "use strict";

  // --- Configure marked.js ---
  if (typeof marked !== "undefined") {
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight: function (code, lang) {
        if (typeof hljs !== "undefined" && lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        if (typeof hljs !== "undefined") {
          return hljs.highlightAuto(code).value;
        }
        return code;
      },
    });
  }

  function renderMarkdown(text) {
    if (typeof marked !== "undefined") {
      try {
        return marked.parse(text);
      } catch (e) {
        return escapeHtml(text);
      }
    }
    return escapeHtml(text).replace(/\n/g, "<br>");
  }

  // --- Auth ---
  function bootstrapToken() {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token") || "";
    if (urlToken) {
      localStorage.setItem("codexRemoteToken", urlToken);
      params.delete("token");
      const cleanSearch = params.toString();
      const cleanUrl = window.location.pathname + (cleanSearch ? "?" + cleanSearch : "") + window.location.hash;
      window.history.replaceState(null, "", cleanUrl);
      return urlToken;
    }
    return localStorage.getItem("codexRemoteToken") || "";
  }

  let TOKEN = bootstrapToken();

  function authHeaders() {
    return { "Content-Type": "application/json", "X-Web-Token": TOKEN };
  }
  // --- Login gate ---
  const loginGate = document.getElementById("loginGate");
  const appEl = document.getElementById("app");

  function showLogin() {
    loginGate.style.display = "flex";
    appEl.style.display = "none";
  }
  function hideLogin() {
    loginGate.style.display = "none";
    appEl.style.display = "flex";
  }

  if (!TOKEN) {
    showLogin();
  }

  document.getElementById("loginBtn").addEventListener("click", function () {
    TOKEN = document.getElementById("tokenInput").value.trim();
    if (TOKEN) {
      localStorage.setItem("codexRemoteToken", TOKEN);
      hideLogin();
      init();
    }
  });
  document.getElementById("tokenInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("loginBtn").click();
  });

  // --- State ---
  let currentThreadId = null;
  let threadMeta = {}; // id -> {title, cwd}
  let sseAbortController = null;
  let reconnectTimer = null;
  let sseConnected = false;
  let selectedProject = null; // {label, cwd}
  let lastThreadListJson = "";
  let lastThreadListData = { projects: {}, ungrouped: [] };
  let pendingNewChat = null;
  let webNavigationHold = null;
  let threadPollTimer = null;
  let soundReminderEnabled = localStorage.getItem("codexRemoteSoundEnabled") === "1";
  let audioPermissionPromptEl = null;
  let completionAudioContext = null;
  let lastRemoteStreaming = false;
  let lastStreamingThreadId = "";
  let lastCompletionKey = "";
  let remoteStateSeen = false;
  let remoteToastTimer = null;

  const COMPLETION_PREVIEW_LIMIT = 120;
  const COMPLETION_TOAST_MS = 5000;
  const COMPLETION_SOUND_GAIN = 0.08;
  const COMPLETION_SOUND_DURATION = 0.16;
  const WEB_NAVIGATION_HOLD_MS = 5000;

  // --- DOM refs ---
  const threadListEl = document.getElementById("threadList");
  const messageListEl = document.getElementById("messageList");
  const promptInput = document.getElementById("promptInput");
  const sendBtn = document.getElementById("sendBtn");
  const chatTitle = document.getElementById("chatTitle");
  const connDot = document.getElementById("connectionDot");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const searchInput = document.getElementById("searchInput");
  const selectedProjectEl = document.getElementById("selectedProject");
  const selectedProjectName = document.getElementById("selectedProjectName");
  const clearProjectBtn = document.getElementById("clearProjectBtn");

  // --- Init ---
  function init() {
    loadThreadList();
    connectSSE();
    checkHealth();
    showAudioPermissionPrompt();
    // Re-inject automation script to ensure it's active
    fetch("/api/remote/reinject", { method: "POST", headers: authHeaders() }).catch(function () {});
    if (!threadPollTimer) {
      threadPollTimer = setInterval(loadThreadList, 1000);
    }
  }

  window.addEventListener("beforeunload", function () {
    if (threadPollTimer) { clearInterval(threadPollTimer); threadPollTimer = null; }
  });

  // --- Health check ---
  async function checkHealth() {
    try {
      const r = await fetch("/health");
      if (r.ok) {
        connDot.className = "conn-dot ok";
      } else {
        connDot.className = "conn-dot err";
      }
    } catch {
      connDot.className = "conn-dot err";
    }
  }

  // --- Completion alerts ---
  function showAudioPermissionPrompt() {
    if (soundReminderEnabled || audioPermissionPromptEl || !supportsAudioReminder()) return;
    const el = document.createElement("div");
    el.className = "audio-permission-banner";
    el.innerHTML = '<div class="audio-prompt-copy">' +
      '<strong>启用任务完成提示音</strong>' +
      '<span>点击授权后，Codex 完成回复时会播放提示音。</span>' +
      '</div>' +
      '<div class="audio-prompt-actions">' +
      '<button type="button" class="btn-audio-enable">启用声音提醒</button>' +
      '<button type="button" class="btn-audio-later">稍后</button>' +
      '</div>';
    el.querySelector(".btn-audio-enable").addEventListener("click", enableSoundReminder);
    el.querySelector(".btn-audio-later").addEventListener("click", hideAudioPermissionPrompt);
    document.body.appendChild(el);
    audioPermissionPromptEl = el;
  }

  function hideAudioPermissionPrompt() {
    if (!audioPermissionPromptEl) return;
    audioPermissionPromptEl.remove();
    audioPermissionPromptEl = null;
  }

  function supportsAudioReminder() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }

  async function enableSoundReminder() {
    try {
      await ensureAudioContext();
      soundReminderEnabled = true;
      localStorage.setItem("codexRemoteSoundEnabled", "1");
      hideAudioPermissionPrompt();
      playCompletionSound();
      requestNotificationPermission();
      showRemoteToast("声音提醒已启用", "任务完成后会在此页面播放提示音。");
    } catch (e) {
      showRemoteToast("无法启用声音", "请确认浏览器允许此页面播放音频后重试。");
    }
  }

  async function ensureAudioContext() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error("AudioContext unavailable");
    if (!completionAudioContext) completionAudioContext = new AudioCtor();
    if (completionAudioContext.state === "suspended") {
      await completionAudioContext.resume();
    }
    return completionAudioContext;
  }

  function playCompletionSound() {
    if (!soundReminderEnabled) {
      showAudioPermissionPrompt();
      return;
    }
    ensureAudioContext().then(playCompletionTone).catch(showAudioPermissionPrompt);
  }

  function playCompletionTone(ctx) {
    const now = ctx.currentTime;
    [660, 880].forEach(function (frequency, index) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const startAt = now + index * COMPLETION_SOUND_DURATION;
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(COMPLETION_SOUND_GAIN, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + COMPLETION_SOUND_DURATION);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + COMPLETION_SOUND_DURATION + 0.03);
    });
  }

  function requestNotificationPermission() {
    if (!("Notification" in window) || Notification.permission !== "default") return;
    Promise.resolve(Notification.requestPermission()).catch(function () {});
  }

  function showRemoteToast(title, message) {
    var toast = document.getElementById("remoteCompletionToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "remoteCompletionToast";
      toast.className = "remote-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }
    toast.innerHTML = '<strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(message) + '</span>';
    toast.classList.add("visible");
    clearTimeout(remoteToastTimer);
    remoteToastTimer = setTimeout(function () { toast.classList.remove("visible"); }, COMPLETION_TOAST_MS);
  }

  // --- Project selection ---
  function selectProject(label, cwd) {
    selectedProject = { label: label, cwd: cwd };
    selectedProjectName.textContent = label;
    selectedProjectEl.style.display = "flex";
    highlightProjectDot(label);
  }

  function clearProject() {
    selectedProject = null;
    selectedProjectEl.style.display = "none";
    selectedProjectName.textContent = "";
    highlightProjectDot(null);
  }

  function highlightProjectDot(label) {
    document.querySelectorAll(".project-header").forEach(function (hdr) {
      var isThis = label && hdr.dataset.projectLabel === label;
      hdr.classList.toggle("selected", isThis);
      var dot = hdr.querySelector(".project-select-dot");
      if (dot) dot.classList.toggle("selected", isThis);
    });
  }

  clearProjectBtn.addEventListener("click", clearProject);

  // --- Thread list ---
  async function loadThreadList() {
    try {
      const r = await fetch("/api/remote/threads", { headers: authHeaders() });
      if (r.status === 401) {
        showLogin();
        return;
      }
      const data = await r.json();
      var json = JSON.stringify(data);
      if (json === lastThreadListJson) return;
      lastThreadListJson = json;
      lastThreadListData = data;
      renderThreadList(data);
      updateCurrentThreadHeader();
      if (!maybeAutoOpenPendingNewChat(data) && currentThreadId) highlightThread(currentThreadId);
    } catch (e) {
      // Silently fail on poll errors to avoid disrupting the UI
    }
  }

  function flattenThreadsFromData(data) {
    const threads = [];
    const projects = data && data.projects ? data.projects : {};
    Object.keys(projects).forEach(function (name) {
      (projects[name] || []).forEach(function (thread) { threads.push(thread); });
    });
    ((data && data.ungrouped) || []).forEach(function (thread) { threads.push(thread); });
    return threads;
  }

  function rememberPendingNewChat() {
    pendingNewChat = {
      startedAt: Date.now(),
      cwd: selectedProject && selectedProject.cwd ? selectedProject.cwd : "",
      label: selectedProject && selectedProject.label ? selectedProject.label : "",
      knownThreadIds: new Set(flattenThreadsFromData(lastThreadListData).map(function (thread) { return thread.id; })),
    };
  }

  function maybeAutoOpenPendingNewChat(data) {
    if (!pendingNewChat) return false;
    const isExpired = Date.now() - pendingNewChat.startedAt > 30000;
    if (isExpired) {
      pendingNewChat = null;
      return false;
    }
    const candidates = flattenThreadsFromData(data).filter(function (thread) {
      if (!thread.id || pendingNewChat.knownThreadIds.has(thread.id)) return false;
      return !pendingNewChat.cwd || !thread.cwd || thread.cwd === pendingNewChat.cwd;
    });
    if (candidates.length === 0) return false;
    candidates.sort(function (a, b) { return threadSortMs(b) - threadSortMs(a); });
    const candidate = candidates[0];
    pendingNewChat = null;
    navigateToThread(candidate.id, { auto: true });
    return true;
  }

  function threadSortMs(thread) {
    return Number(thread.updated_at_ms || thread.created_at_ms || 0);
  }

  function renderThreadList(data) {
    threadListEl.innerHTML = "";
    threadMeta = {};
    const projects = data.projects || {};
    const ungrouped = data.ungrouped || [];
    const projectNames = Object.keys(projects);

    if (projectNames.length === 0 && ungrouped.length === 0) {
      threadListEl.innerHTML = '<div class="empty-state"><p>No conversations found</p></div>';
      return;
    }

    // Project groups
    for (const name of projectNames) {
      const threads = projects[name];
      threads.forEach(function (t) { threadMeta[t.id] = t; });
      // Get cwd from the first thread that has it
      var cwd = "";
      for (var i = 0; i < threads.length; i++) {
        if (threads[i].cwd) { cwd = threads[i].cwd; break; }
      }
      const group = createProjectGroup(name, threads, cwd);
      threadListEl.appendChild(group);
    }

    // Ungrouped
    if (ungrouped.length > 0) {
      ungrouped.forEach(function (t) { threadMeta[t.id] = t; });
      const group = createProjectGroup("Chats", ungrouped, "");
      threadListEl.appendChild(group);
    }

    // Restore project dot highlight
    if (selectedProject) {
      highlightProjectDot(selectedProject.label);
    }
  }

  function createProjectGroup(label, threads, cwd) {
    const frag = document.createElement("div");

    const header = document.createElement("div");
    header.className = "project-header";
    header.dataset.projectLabel = label;
    header.dataset.projectCwd = cwd || "";

    var arrowSpan = '<span class="arrow">&#9660;</span> ';
    var labelSpan = escapeHtml(label);
    var dotSpan = cwd ? ' <span class="project-select-dot"></span>' : "";
    header.innerHTML = arrowSpan + labelSpan + dotSpan;

    header.addEventListener("click", function (e) {
      // If clicked the dot area, toggle project selection
      if (e.target.classList.contains("project-select-dot") || (cwd && e.offsetX > header.offsetWidth - 30)) {
        if (selectedProject && selectedProject.label === label) {
          clearProject();
        } else {
          selectProject(label, cwd);
        }
        return;
      }
      header.classList.toggle("collapsed");
    });

    // Right-click to select project
    if (cwd) {
      header.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        if (selectedProject && selectedProject.label === label) {
          clearProject();
        } else {
          selectProject(label, cwd);
        }
      });
    }

    frag.appendChild(header);

    const list = document.createElement("div");
    list.className = "project-threads";
    threads.forEach(function (t) {
      list.appendChild(createThreadItem(t));
    });
    frag.appendChild(list);

    return frag;
  }

  function createThreadItem(t) {
    const btn = document.createElement("button");
    btn.className = "thread-item";
    btn.dataset.threadId = t.id;
    const title = t.title || "Untitled";
    const time = t.updated_at_ms ? formatRelativeTime(t.updated_at_ms) : "";
    btn.innerHTML = escapeHtml(title) + (time ? '<span class="thread-time">' + escapeHtml(time) + "</span>" : "");
    btn.addEventListener("click", function () { navigateToThread(t.id); });
    return btn;
  }

  function formatRelativeTime(ms) {
    const diff = Date.now() - ms;
    if (diff < 60000) return "now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h";
    if (diff < 604800000) return Math.floor(diff / 86400000) + "d";
    return Math.floor(diff / 604800000) + "w";
  }

  function normalizeThreadId(threadId) {
    return String(threadId || "").trim().replace(/^local:/, "");
  }

  function canonicalThreadId(threadId) {
    const normalized = normalizeThreadId(threadId);
    return normalized || String(threadId || "").trim();
  }

  function sameThreadId(left, right) {
    const leftId = normalizeThreadId(left);
    const rightId = normalizeThreadId(right);
    return !!leftId && !!rightId && leftId === rightId;
  }

  // --- Search ---
  searchInput.addEventListener("input", function () {
    const q = searchInput.value.toLowerCase();
    document.querySelectorAll(".thread-item").forEach(function (el) {
      el.style.display = el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });

  // --- Navigation ---
  async function navigateToThread(threadId, options) {
    options = options || {};
    if (!options.auto) pendingNewChat = null;
    currentThreadId = threadId;
    if (!options.fromDomState) rememberWebNavigationHold(threadId);
    highlightThread(threadId);
    closeSidebar();

    updateCurrentThreadHeader();

    if (!options.preserveMessages) {
      messageListEl.innerHTML = '<div class="msg-loading">Loading...</div>';
    }

    try {
      await fetch("/api/remote/navigate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ thread_id: threadId }),
      });
    } catch (e) { /* ignore */ }

    // Messages will arrive via SSE from DOM reporter
    setTimeout(function () {
      var loading = messageListEl.querySelector(".msg-loading");
      if (loading && messageListEl.children.length === 1) {
        loading.textContent = "Waiting for messages...";
      }
    }, 3000);
  }

  function updateCurrentThreadHeader() {
    if (!currentThreadId) return;
    const meta = threadMeta[currentThreadId];
    chatTitle.textContent = meta ? meta.title || "Untitled" : currentThreadId;
    if (meta && meta.cwd) {
      var label = meta.cwd.split("/").pop() || meta.cwd;
      selectProject(label, meta.cwd);
    }
  }

  function highlightThread(id) {
    document.querySelectorAll(".thread-item").forEach(function (el) {
      el.classList.toggle("active", el.dataset.threadId === id);
    });
  }

  // --- SSE ---
  async function connectSSE() {
    if (sseAbortController) { sseAbortController.abort(); }
    if (!TOKEN) return;

    const controller = new AbortController();
    sseAbortController = controller;

    try {
      const response = await fetch("/api/remote/dom-state", { headers: authHeaders(), signal: controller.signal });
      if (response.status === 401) {
        showLogin();
        setSSEStatus(false);
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error("SSE connection failed");
      }
      setSSEStatus(true);
      await readSSEStream(response.body, function (data) {
        try {
          var state = JSON.parse(data);
          handleDomState(state);
          setSSEStatus(true);
        } catch (err) { /* ignore */ }
      });
    } catch (e) {
      if (controller.signal.aborted) return;
    } finally {
      if (sseAbortController === controller) {
        sseAbortController = null;
        setSSEStatus(false);
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectSSE, 3000);
      }
    }
  }

  async function readSSEStream(body, onData) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";
      parts.forEach(function (eventText) {
        const lines = eventText.split(/\r?\n/);
        const dataLines = lines
          .filter(function (line) { return line.startsWith("data:"); })
          .map(function (line) { return line.slice(5).trimStart(); });
        if (dataLines.length > 0) onData(dataLines.join("\n"));
      });
    }
  }

  function setSSEStatus(ok) {
    sseConnected = ok;
    connDot.className = "conn-dot " + (ok ? "ok" : "err");
  }

  function handleDomState(state) {
    const previousStreaming = lastRemoteStreaming;
    const previousThreadId = lastStreamingThreadId;
    const stateThreadId = state.active_thread_id ? canonicalThreadId(state.active_thread_id) : "";

    // 桌面端切换了线程，但 Web 用户正在查看特定线程时不跟随
    if (stateThreadId && !sameThreadId(stateThreadId, currentThreadId)) {
      if (state.web_active_thread && sameThreadId(state.web_active_thread, currentThreadId)) {
        // Web 用户正在查看特定线程，不跟随桌面端
      } else if (isHoldingCurrentWebThread()) {
        // Web 刚主动切换线程，等待 /navigate 更新 dom-state，避免被旧桌面状态切回。
      } else {
        navigateToThread(stateThreadId, { auto: true, preserveMessages: true, fromDomState: true });
      }
    } else if (stateThreadId && sameThreadId(stateThreadId, currentThreadId)) {
      clearWebNavigationHold(currentThreadId);
    }

    if (state.messages && state.messages.length > 0) {
      renderMessages(state.messages, state.is_streaming);
    }

    maybeNotifyTaskCompleted({ ...state, active_thread_id: stateThreadId || state.active_thread_id }, previousStreaming, previousThreadId);
    lastRemoteStreaming = !!state.is_streaming;
    if (stateThreadId) lastStreamingThreadId = stateThreadId;
    remoteStateSeen = true;
  }

  function maybeNotifyTaskCompleted(state, previousStreaming, previousThreadId) {
    if (!remoteStateSeen || !previousStreaming || state.is_streaming) return;
    if (!state.active_thread_id || previousThreadId !== state.active_thread_id) return;
    const assistantMessage = lastAssistantMessage(state.messages || []);
    if (!assistantMessage) return;
    const key = state.active_thread_id + ":" + assistantMessage.content;
    if (key === lastCompletionKey) return;
    lastCompletionKey = key;
    const preview = assistantMessage.content.slice(0, COMPLETION_PREVIEW_LIMIT);
    showRemoteToast("任务已完成", preview);
    playCompletionSound();
    showCompletionNotification(preview);
  }

  function rememberWebNavigationHold(threadId) {
    webNavigationHold = { threadId: threadId, until: Date.now() + WEB_NAVIGATION_HOLD_MS };
  }

  function clearWebNavigationHold(threadId) {
    if (webNavigationHold && webNavigationHold.threadId === threadId) {
      webNavigationHold = null;
    }
  }

  function isHoldingCurrentWebThread() {
    if (!webNavigationHold || webNavigationHold.threadId !== currentThreadId) return false;
    if (Date.now() <= webNavigationHold.until) return true;
    webNavigationHold = null;
    return false;
  }

  function lastAssistantMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === "assistant" && String(msg.content || "").trim()) {
        return { content: String(msg.content).trim() };
      }
    }
    return null;
  }

  function showCompletionNotification(message) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification("Codex++ 任务已完成", {
        body: message || "远程会话已有新的回复。",
        silent: true,
      });
    } catch (e) { /* ignore */ }
  }

  // --- Message rendering ---
  function renderMessages(messages, isStreaming) {
    // Hide empty state
    var empty = messageListEl.querySelector(".empty-state");
    if (empty) empty.remove();
    var loading = messageListEl.querySelector(".msg-loading");
    if (loading) loading.remove();

    var existing = messageListEl.children;
    var len = Math.max(messages.length, existing.length);

    for (var i = 0; i < len; i++) {
      if (i >= messages.length) {
        // Remove excess
        while (messageListEl.children.length > messages.length) {
          messageListEl.removeChild(messageListEl.lastChild);
        }
        break;
      }

      var msg = messages[i];
      var el = existing[i];

      if (!el || el.dataset.role !== msg.role) {
        var newEl = document.createElement("div");
        newEl.className = "msg " + msg.role;
        newEl.dataset.role = msg.role;
        if (el) {
          messageListEl.replaceChild(newEl, el);
        } else {
          messageListEl.appendChild(newEl);
        }
        el = newEl;
      }

      // Render markdown for assistant messages, plain text for user/system
      if (msg.role === "assistant") {
        el.innerHTML = '<div class="md-content">' + renderMarkdown(msg.content) + '</div>';
      } else {
        el.textContent = msg.content;
      }

      if (msg.role === "assistant" && i === messages.length - 1 && isStreaming) {
        el.classList.add("streaming");
      } else {
        el.classList.remove("streaming");
      }
    }

    scrollToBottom();
  }

  function scrollToBottom() {
    function applyScrollToBottom() {
      messageListEl.scrollTop = messageListEl.scrollHeight;
    }
    applyScrollToBottom();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(applyScrollToBottom);
    }
    setTimeout(applyScrollToBottom, 50);
    setTimeout(applyScrollToBottom, 200);
  }

  // --- Send message ---
  promptInput.addEventListener("input", function () {
    sendBtn.disabled = !promptInput.value.trim();
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, 150) + "px";
  });

  sendBtn.addEventListener("click", sendMessage);
  promptInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage();
    }
  });

  async function sendMessage() {
    var prompt = promptInput.value.trim();
    if (!prompt) return;

    promptInput.value = "";
    promptInput.style.height = "auto";
    sendBtn.disabled = true;

    // Show user message immediately
    appendMessage("user", prompt);

    try {
      var body = { prompt: prompt };
      if (currentThreadId) body.thread_id = currentThreadId;
      var r = await fetch("/api/remote/send", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      var data = await r.json();
      if (!data.ok) {
        appendMessage("system", "Failed to send: " + (data.error || "unknown error"));
        return;
      }
      // Poll for the response from Codex
      if (data.id) {
        pollActionResult(data.id, function (result) {
          if (result.status === "success" && result.content) {
            appendMessage("assistant", result.content);
          } else if (result.status === "error") {
            appendMessage("system", "Error: " + (result.content || "unknown error"));
          } else if (result.status === "timeout") {
            appendMessage("system", "Response timeout - check Codex for the reply");
          }
        }, 300); // 5 min timeout for long responses
      }
    } catch (e) {
      appendMessage("system", "Network error: " + e.message);
    }
  }

  function appendMessage(role, content) {
    var empty = messageListEl.querySelector(".empty-state");
    if (empty) empty.remove();

    var el = document.createElement("div");
    el.className = "msg " + role;
    el.dataset.role = role;
    if (role === "assistant") {
      el.innerHTML = '<div class="md-content">' + renderMarkdown(content) + '</div>';
    } else {
      el.textContent = content;
    }
    messageListEl.appendChild(el);
    scrollToBottom();
  }

  // --- New chat ---
  document.getElementById("newChatBtn").addEventListener("click", async function () {
    try {
      var body = {};
      if (selectedProject && selectedProject.cwd) {
        body.cwd = selectedProject.cwd;
      }
      rememberPendingNewChat();
      var r = await fetch("/api/remote/new-chat", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      var data = await r.json();
      currentThreadId = null;
      var titleText = selectedProject ? "New Chat - " + selectedProject.label : "New Chat";
      chatTitle.textContent = titleText;
      messageListEl.innerHTML = '<div class="empty-state"><p>Creating new conversation...</p>' +
        (selectedProject ? '<p style="font-size:12px;margin-top:6px;color:var(--accent)">Project: ' + escapeHtml(selectedProject.label) + '</p>' : '') +
        '</div>';
      highlightThread(null);
      closeSidebar();

      // Poll for the result of the new-chat action
      if (data.ok && data.id) {
        pollActionResult(data.id, function (result) {
          if (result.status === "success") {
            var emptyState = messageListEl.querySelector(".empty-state");
            if (emptyState && emptyState.textContent.includes("Creating")) {
              emptyState.innerHTML = '<p>New conversation started</p>' +
                (selectedProject ? '<p style="font-size:12px;margin-top:6px;color:var(--accent)">Project: ' + escapeHtml(selectedProject.label) + '</p>' : '') +
                '</div>';
            }
            // Reload thread list to pick up the new session
            setTimeout(loadThreadList, 500);
            setTimeout(loadThreadList, 1500);
            setTimeout(loadThreadList, 3000);
          } else if (result.status === "error") {
            pendingNewChat = null;
            appendMessage("system", "Failed to create new chat: " + (result.content || "unknown error"));
          }
        });
      } else {
        pendingNewChat = null;
      }
    } catch (e) {
      pendingNewChat = null;
      appendMessage("system", "Network error: " + e.message);
    }
  });

  // Poll for action results (new_chat, send, etc.)
  function pollActionResult(actionId, callback, maxAttempts) {
    maxAttempts = maxAttempts || 60;
    var attempts = 0;
    var timer = setInterval(async function () {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(timer);
        callback({ status: "timeout", content: "Action timed out" });
        return;
      }
      try {
        var r = await fetch("/api/remote/result/" + actionId, { headers: authHeaders() });
        var data = await r.json();
        if (data.status && data.status !== "pending" && data.status !== "not_found") {
          clearInterval(timer);
          callback(data);
        }
      } catch (e) { /* ignore */ }
    }, 1000);
  }

  // --- Refresh ---
  document.getElementById("refreshBtn").addEventListener("click", function () {
    loadThreadList();
    checkHealth();
  });

  // --- Sidebar mobile toggle ---
  document.getElementById("sidebarToggle").addEventListener("click", function () {
    sidebar.classList.toggle("open");
    overlay.classList.toggle("visible");
  });
  overlay.addEventListener("click", closeSidebar);

  function closeSidebar() {
    sidebar.classList.remove("open");
    overlay.classList.remove("visible");
  }

  // --- Helpers ---
  function escapeHtml(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // --- Boot ---
  if (TOKEN) init();
})();
