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
  let threadPollTimer = null;

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
      renderThreadList(data);
      if (currentThreadId) highlightThread(currentThreadId);
    } catch (e) {
      // Silently fail on poll errors to avoid disrupting the UI
    }
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

  // --- Search ---
  searchInput.addEventListener("input", function () {
    const q = searchInput.value.toLowerCase();
    document.querySelectorAll(".thread-item").forEach(function (el) {
      el.style.display = el.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });

  // --- Navigation ---
  async function navigateToThread(threadId) {
    currentThreadId = threadId;
    highlightThread(threadId);
    closeSidebar();

    const meta = threadMeta[threadId];
    chatTitle.textContent = meta ? meta.title || "Untitled" : threadId;

    // Auto-select the project this thread belongs to
    if (meta && meta.cwd) {
      var label = meta.cwd.split("/").pop() || meta.cwd;
      selectProject(label, meta.cwd);
    }

    messageListEl.innerHTML = '<div class="msg-loading">Loading...</div>';

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
    // 桌面端切换了线程，但 Web 用户正在查看特定线程时不跟随
    if (state.active_thread_id && state.active_thread_id !== currentThreadId) {
      if (state.web_active_thread && state.web_active_thread === currentThreadId) {
        // Web 用户正在查看特定线程，不跟随桌面端
      } else {
        currentThreadId = state.active_thread_id;
        highlightThread(currentThreadId);
        var meta = threadMeta[currentThreadId];
        if (meta) {
          chatTitle.textContent = meta.title || "Untitled";
          if (meta.cwd) {
            var label = meta.cwd.split("/").pop() || meta.cwd;
            selectProject(label, meta.cwd);
          }
        }
      }
    }

    if (state.messages && state.messages.length > 0) {
      renderMessages(state.messages, state.is_streaming);
    }
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
    messageListEl.scrollTop = messageListEl.scrollHeight;
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
            setTimeout(loadThreadList, 2000);
          } else if (result.status === "error") {
            appendMessage("system", "Failed to create new chat: " + (result.content || "unknown error"));
          }
        });
      }
    } catch (e) {
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
