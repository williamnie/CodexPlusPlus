(() => {
  if (window.__codexConversationAutomationTimers) {
    window.__codexConversationAutomationTimers.forEach((timer) => clearInterval(timer));
  }
  window.__codexConversationAutomationTimers = [];
  try { console.clear(); } catch (e) {}
  installLegacyHelperRequestShield();
  window.__codexConversationAutomation = true;

  const resultCallbacks = {};

  // --- Helpers ---

  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); clearTimeout(timer); resolve(el); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => { obs.disconnect(); reject(new Error("Timeout: " + selector)); }, timeout);
    });
  }

  function findNewChatButton() {
    const selectors = [
      'button[aria-label="New chat"]',
      'button[aria-label="新对话"]',
      'button[aria-label="New Chat"]',
      'a[href="/"]',
      'button[data-testid="new-chat"]',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) return el;
    }
    for (const btn of document.querySelectorAll("button")) {
      if (btn.offsetParent === null) continue;
      const text = btn.textContent.trim();
      if (text === "New chat" || text === "新对话" || text === "新建对话") return btn;
    }
    return null;
  }

  function normalizeWorkspacePath(path) {
    const normalized = String(path || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized || String(path || "").trim();
  }

  function workspacePathMatches(left, right) {
    const leftPath = normalizeWorkspacePath(left);
    const rightPath = normalizeWorkspacePath(right);
    return !!leftPath && !!rightPath && leftPath === rightPath;
  }

  function normalizeThreadId(threadId) {
    return String(threadId || "").trim().replace(/^local:/, "");
  }

  function threadIdVariants(threadId) {
    const variants = new Set();
    const raw = String(threadId || "").trim();
    const id = normalizeThreadId(raw);
    if (raw) variants.add(raw);
    if (id) {
      variants.add(id);
      variants.add("local:" + id);
    }
    return Array.from(variants);
  }

  function sameThreadId(left, right) {
    const leftId = normalizeThreadId(left);
    const rightId = normalizeThreadId(right);
    return !!leftId && !!rightId && leftId === rightId;
  }

  function findProjectNewChatButton(cwd) {
    if (!cwd) return null;
    const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"));
    for (const row of rows) {
      const projectId = row.getAttribute("data-app-action-sidebar-project-id") || "";
      if (!workspacePathMatches(projectId, cwd)) continue;
      const scope = row.closest('[role="listitem"]') || row.parentElement || row;
      const candidates = Array.from(scope.querySelectorAll("button")).filter((button) => {
        if (button.offsetParent === null) return false;
        const label = [
          button.getAttribute("aria-label") || "",
          button.getAttribute("title") || "",
          button.textContent || "",
        ].join(" ");
        if (/项目操作|project actions/i.test(label)) return false;
        return /开始新对话|新对话|new chat|start/i.test(label);
      });
      if (candidates.length > 0) return candidates[candidates.length - 1];
    }
    return null;
  }

  function getActiveThreadId() {
    const urlMatch = window.location.href.match(/thread[=/:]([A-Za-z0-9_.-]+)/i);
    if (urlMatch) return urlMatch[1];
    const rows = document.querySelectorAll('[data-app-action-sidebar-thread-id]');
    for (const r of rows) {
      if (r.getAttribute("aria-current") === "page" || r.getAttribute("aria-current") === "true") {
        return r.getAttribute("data-app-action-sidebar-thread-id");
      }
      const href = r.getAttribute("href") || "";
      if (href && window.location.href.includes(href)) {
        return r.getAttribute("data-app-action-sidebar-thread-id");
      }
    }
    return null;
  }

  function findTextarea() {
    const selectors = [
      "textarea#prompt-textarea",
      'textarea[placeholder][data-testid]',
      'div[contenteditable="true"][data-codex-composer="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      "textarea",
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  function setNativeValue(el, value) {
    // React stores a reference to the native setter; use it to bypass React's controlled component
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(el, value);
  }

  // --- Core ---

  async function handleNewChat(msgId, cwd, prompt) {
    try {
      // Prefer Codex's native per-project new-chat button when a remote project
      // was selected; otherwise fall back to the global new-chat button.
      const btn = findProjectNewChatButton(cwd) || findNewChatButton();
      if (!btn) {
        reportResult(msgId, "error", "Cannot find new chat button");
        return;
      }
      btn.click();

      // Wait for the textarea to appear in the new conversation
      await new Promise(r => setTimeout(r, 800));
      const textarea = await waitForElement("textarea, div[contenteditable='true']", 10000);

      if (prompt && prompt.trim()) {
        // Inject the prompt into the new conversation
        await injectPromptIntoTextarea(textarea, prompt);
        const submitted = await submitPrompt();
        if (!submitted) {
          reportResult(msgId, "error", "Cannot find enabled submit button");
          return;
        }
        observeResponse(msgId, prompt);
      } else {
        reportResult(msgId, "success", "New chat created");
      }
    } catch (err) {
      reportResult(msgId, "error", err.message);
    }
  }

  async function sendMessage(prompt, msgId, threadId) {
    try {
      if (threadId && !(await navigateToThreadById(threadId))) {
        reportResult(msgId, "error", "Cannot switch to target thread");
        return;
      }
      let textarea = findTextarea();
      if (!textarea) {
        if (!threadId) {
          // No textarea found for an untargeted send - preserve the legacy new-chat fallback.
          const btn = findNewChatButton();
          if (btn) {
            btn.click();
            await new Promise(r => setTimeout(r, 800));
            try {
              textarea = await waitForElement("textarea, div[contenteditable='true']", 10000);
            } catch (e) {
              reportResult(msgId, "error", "Cannot find textarea after creating new chat");
              return;
            }
          }
        }
        if (!textarea) {
          reportResult(msgId, "error", "Cannot find textarea or new chat button");
          return;
        }
      }

      await injectPromptIntoTextarea(textarea, prompt);
      const submitted = await submitPrompt();
      if (!submitted) {
        reportResult(msgId, "error", "Cannot find enabled submit button");
        return;
      }
      observeResponse(msgId, prompt);
    } catch (err) {
      reportResult(msgId, "error", err.message);
    }
  }

  async function injectPromptIntoTextarea(textarea, prompt) {
    textarea.focus();

    if (textarea.tagName === "TEXTAREA" || textarea.tagName === "INPUT") {
      setNativeValue(textarea, prompt);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      // Also fire InputEvent for newer React versions
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: prompt,
      }));
    } else {
      selectEditableContents(textarea);
      const inserted = document.execCommand("insertText", false, prompt);
      if (!inserted) {
        textarea.textContent = prompt;
        textarea.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: prompt,
        }));
      }
    }

    // Give React time to process the event and enable the submit button
    await new Promise(r => setTimeout(r, 500));
  }

  function selectEditableContents(el) {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function findComposerRoot() {
    const composer = findTextarea();
    let current = composer;
    for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
      if (current.querySelectorAll("button").length >= 2) return current;
    }
    return composer?.parentElement || document;
  }

  function findSubmitButton() {
    const root = findComposerRoot();
    const submitSelectors = ['button[data-testid="send-button"]', 'button[aria-label="Send"]', 'button[aria-label="发送"]'];
    for (const s of submitSelectors) {
      const explicit = root.querySelector(s) || document.querySelector(s);
      if (explicit && !explicit.disabled && explicit.offsetParent !== null) return explicit;
    }

    const buttons = Array.from(root.querySelectorAll("button"));
    for (let i = buttons.length - 1; i >= 0; i--) {
      const btn = buttons[i];
      if (btn.disabled || btn.offsetParent === null) continue;
      const label = [
        btn.getAttribute("aria-label") || "",
        btn.getAttribute("title") || "",
        btn.textContent || "",
      ].join(" ");
      if (/stop|停止|添加|文件|权限|access|model|模型/i.test(label)) continue;
      if ((btn.textContent || "").trim()) continue;
      if (btn.querySelector("svg")) return btn;
    }
    return null;
  }

  function dispatchEnterSubmit() {
    const textarea = findTextarea();
    if (!textarea) return false;
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
      cancelable: true,
    }));
    textarea.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
      cancelable: true,
    }));
    return true;
  }

  function findThreadLinkById(threadId) {
    if (!threadId) return null;
    for (const variant of threadIdVariants(threadId)) {
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(variant) : variant.replace(/"/g, '\"');
      const direct = document.querySelector(`[data-app-action-sidebar-thread-id="${escaped}"]`);
      if (direct && direct.offsetParent !== null) return direct;
    }
    const links = Array.from(document.querySelectorAll("a[href], button[data-href]"));
    const variants = threadIdVariants(threadId);
    for (const link of links) {
      if (link.offsetParent === null) continue;
      const href = link.getAttribute("href") || link.getAttribute("data-href") || "";
      if (variants.some((variant) => href.includes(variant))) return link;
    }
    return null;
  }

  function activateThreadRow(row) {
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    if (typeof PointerEvent !== "undefined") {
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    }
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, buttons: 1 }));
    if (typeof PointerEvent !== "undefined") {
      row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    }
    row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  async function navigateToThreadById(threadId) {
    if (!threadId || sameThreadId(getActiveThreadId(), threadId)) return true;
    const link = findThreadLinkById(threadId);
    if (!link) return false;
    activateThreadRow(link);
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 150));
      if (sameThreadId(getActiveThreadId(), threadId)) return true;
    }
    return sameThreadId(getActiveThreadId(), threadId);
  }

  async function submitPrompt() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const submitBtn = findSubmitButton();
      if (!submitBtn) {
        await new Promise(r => setTimeout(r, 150));
        continue;
      }
      submitBtn.click();
      await new Promise(r => setTimeout(r, 150));
      return true;
    }
    return dispatchEnterSubmit();
  }

  function observeResponse(msgId, prompt) {
    let checkCount = 0;
    const maxChecks = 300;
    let lastContent = "";
    let stableCount = 0;

    const interval = setInterval(() => {
      checkCount++;
      if (checkCount > maxChecks) {
        clearInterval(interval);
        reportResult(msgId, "timeout", lastContent || "Response timeout after 5 minutes");
        return;
      }

      // Look for streaming indicator
      const streamingIndicators = [
        'button[aria-label="Stop"]',
        'button[aria-label="停止"]',
        'button[aria-label="Stop generating"]',
        '.result-streaming',
      ];
      let isStreaming = false;
      for (const sel of streamingIndicators) {
        if (document.querySelector(sel)) { isStreaming = true; break; }
      }

      // Extract latest assistant message
      const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const content = lastMsg.innerText || lastMsg.textContent || "";
        if (content.trim()) {
          if (content.trim() === lastContent) {
            stableCount++;
          } else {
            stableCount = 0;
            lastContent = content.trim();
          }
        }
      }

      // Done when: no longer streaming AND content has stabilized for 2 checks
      if (!isStreaming && lastContent && stableCount >= 2) {
        clearInterval(interval);
        reportResult(msgId, "success", lastContent);
      }
    }, 1000);
  }

  function reportResult(msgId, status, content) {
    if (resultCallbacks[msgId]) {
      resultCallbacks[msgId]({ status, content });
      delete resultCallbacks[msgId];
    }
    helperRequest("/api/callback", { id: msgId, status, content }).catch(() => {});
  }

  // --- Polling ---

  function helperOrigin() {
    try {
      return new URL(window.__CODEX_SESSION_DELETE_HELPER__ || "http://127.0.0.1:57321").origin;
    } catch (e) {
      return "http://127.0.0.1:57321";
    }
  }

  function helperPathFromRequest(input) {
    try {
      const url = new URL(input && input.url ? input.url : String(input), window.location.href);
      return url.origin === helperOrigin() ? url.pathname : "";
    } catch (e) {
      return "";
    }
  }

  function jsonResponse(payload) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function parseRequestBody(init) {
    if (!init || !init.body || typeof init.body !== "string") return {};
    try {
      return JSON.parse(init.body);
    } catch (e) {
      return {};
    }
  }

  function installLegacyHelperRequestShield() {
    if (!window.__codexConversationNativeFetch) {
      window.__codexConversationNativeFetch = window.fetch.bind(window);
    }
    const nativeRequest = window.__codexConversationNativeFetch;
    window.fetch = async function codexConversationHelperRequestShield(input, init) {
      const path = helperPathFromRequest(input);
      if (path === "/api/pending") return jsonResponse({ messages: [] });
      if (path === "/api/callback" || path === "/api/dom-report") {
        await helperRequest(path, parseRequestBody(init)).catch(() => ({}));
        return jsonResponse({ ok: true });
      }
      return nativeRequest.call(window, input, init);
    };
  }

  async function helperRequest(path, payload) {
    if (!window.__codexSessionDeleteBridge) {
      return { ok: false, error: "bridge_unavailable" };
    }
    return await window.__codexSessionDeleteBridge(path, payload || {});
  }

  async function pollMessages() {
    try {
      const data = await helperRequest("/api/pending", {});
      if (data.messages && data.messages.length > 0) {
        for (const msg of data.messages) {
          resultCallbacks[msg.id] = () => {};
          if (msg.action === "new_chat") {
            await handleNewChat(msg.id, msg.cwd || "", msg.prompt || "");
          } else if (msg.action === "navigate_thread") {
            await navigateToThreadById(msg.thread_id);
            reportResult(msg.id, "success", "Thread navigation requested");
          } else {
            await sendMessage(msg.prompt, msg.id, msg.thread_id || "");
          }
        }
      }
    } catch (e) {}
  }

  window.__codexConversationAutomationTimers.push(setInterval(pollMessages, 200));

  // --- DOM State Reporter for Remote Desktop ---
  (function installDomReporter() {
    const REPORT_INTERVAL = 800;
    let lastHash = "";

    function extractMessages() {
      const messages = [];
      const turns = document.querySelectorAll('[data-testid="conversation-turn"]');
      if (turns.length > 0) {
        turns.forEach((turn, i) => {
          const user = turn.querySelector('[data-message-author-role="user"]');
          const assistant = turn.querySelector('[data-message-author-role="assistant"]');
          if (user) messages.push({ role: "user", content: user.innerText || "", index: i });
          if (assistant) messages.push({ role: "assistant", content: assistant.innerText || "", index: i });
        });
      } else {
        document.querySelectorAll('[data-message-author-role="user"]').forEach((el, i) => {
          messages.push({ role: "user", content: el.innerText || "", index: i * 2 });
        });
        document.querySelectorAll('[data-message-author-role="assistant"]').forEach((el, i) => {
          messages.push({ role: "assistant", content: el.innerText || "", index: i * 2 + 1 });
        });
      }
      return messages;
    }

    function isStreaming() {
      const sels = ['button[aria-label="Stop"]', 'button[aria-label="停止"]', '.result-streaming'];
      return sels.some(s => !!document.querySelector(s));
    }

    async function reportDomState() {
      try {
        const tid = getActiveThreadId();
        const msgs = extractMessages();
        const streaming = isStreaming();
        const content = streaming ? (msgs.length > 0 ? msgs[msgs.length - 1].content : "") : "";

        const hash = JSON.stringify({ t: tid, n: msgs.length, s: streaming, c: content.slice(-100) });
        if (hash === lastHash) return;
        lastHash = hash;

        helperRequest("/api/dom-report", {
          active_thread_id: tid,
          messages: msgs,
          is_streaming: streaming,
          streaming_content: content,
          timestamp: Date.now(),
        }).catch(() => {});
      } catch (e) {}
    }

    window.__codexConversationAutomationTimers.push(setInterval(reportDomState, REPORT_INTERVAL));
  })();
})();
