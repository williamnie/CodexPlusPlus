(() => {
  if (window.__codexConversationAutomation) return;
  window.__codexConversationAutomation = true;

  const HELPER_BASE = window.__CODEX_SESSION_DELETE_HELPER__ || "http://127.0.0.1:57321";
  const messageQueue = [];
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
      if (el) return el;
    }
    for (const btn of document.querySelectorAll("button")) {
      const text = btn.textContent.trim();
      if (text === "New chat" || text === "新对话" || text === "新建对话") return btn;
    }
    return null;
  }

  function findTextarea() {
    const selectors = [
      "textarea#prompt-textarea",
      'textarea[placeholder][data-testid]',
      'div[contenteditable="true"][role="textbox"]',
      "textarea",
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  // --- Core ---

  async function sendMessage(prompt, msgId) {
    try {
      let textarea = findTextarea();
      if (!textarea) {
        const btn = findNewChatButton();
        if (!btn) { reportResult(msgId, "error", "Cannot find new chat button"); return; }
        btn.click();
        await new Promise(r => setTimeout(r, 500));
        textarea = await waitForElement("textarea, div[contenteditable='true']", 10000);
      }

      if (textarea.tagName === "TEXTAREA") {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        nativeSetter.call(textarea, prompt);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        textarea.textContent = prompt;
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: prompt }));
      }

      await new Promise(r => setTimeout(r, 300));

      const submitSelectors = [
        'button[data-testid="send-button"]',
        'button[aria-label="Send"]',
        'button[aria-label="发送"]',
        'button[type="submit"]',
      ];
      let submitBtn = null;
      for (const s of submitSelectors) {
        submitBtn = document.querySelector(s);
        if (submitBtn && !submitBtn.disabled) break;
        submitBtn = null;
      }
      if (!submitBtn) {
        for (const btn of document.querySelectorAll("button")) {
          const svg = btn.querySelector("svg");
          if (svg && !btn.disabled && btn.offsetParent) { submitBtn = btn; break; }
        }
      }

      if (submitBtn) {
        submitBtn.click();
      } else {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      }

      observeResponse(msgId, prompt);
    } catch (err) {
      reportResult(msgId, "error", err.message);
    }
  }

  function observeResponse(msgId, prompt) {
    let checkCount = 0;
    const maxChecks = 300;
    let lastContent = "";

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
        if (content.trim()) lastContent = content.trim();
      }

      if (!isStreaming && lastContent) {
        clearInterval(interval);
        reportResult(msgId, "success", lastContent);
      }
    }, 1000);
  }

  function reportResult(msgId, status, content) {
    if (resultCallbacks[msgId]) {
      resultCallbacks[msgId]({ status, content });
    }
    const url = `${HELPER_BASE}/api/callback`;
    try {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: msgId, status, content }),
      }).catch(() => {});
    } catch (e) {}
  }

  // --- Polling ---

  async function pollMessages() {
    try {
      const resp = await fetch(`${HELPER_BASE}/api/pending`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.messages && data.messages.length > 0) {
        for (const msg of data.messages) {
          resultCallbacks[msg.id] = () => {};
          await sendMessage(msg.prompt, msg.id);
        }
      }
    } catch (e) {}
  }

  setInterval(pollMessages, 200);
})();
