import json
import sqlite3
import threading
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import Mock

from codex_session_delete.helper_server import HelperServer
from codex_session_delete.models import DeleteResult, DeleteStatus, ExportResult, ExportStatus, SessionRef


class FakeDeleteService:
    def __init__(self):
        self.deleted = []
        self.undone = []
        self.archived_title_queries = []

    def delete(self, session: SessionRef):
        self.deleted.append(session)
        return DeleteResult(DeleteStatus.LOCAL_DELETED, session.session_id, "Deleted locally", undo_token="u1")

    def undo(self, token: str):
        self.undone.append(token)
        return DeleteResult(DeleteStatus.UNDONE, "s1", "Restored", undo_token=token)

    def find_archived_thread_by_title(self, title: str):
        self.archived_title_queries.append(title)
        return SessionRef(session_id="archived-t1", title=title)

    def move_thread_workspace(self, session: SessionRef, target_cwd: str):
        return {"status": "moved", "session_id": session.session_id, "target_cwd": target_cwd}

    def thread_sort_key(self, session: SessionRef):
        return {"status": "ok", "session_id": session.session_id, "updated_at_ms": 123}

    def thread_sort_keys(self, sessions: list[SessionRef]):
        return {"status": "ok", "sort_keys": [{"session_id": session.session_id, "updated_at_ms": index + 1} for index, session in enumerate(sessions)]}


class FakeExportService:
    def __init__(self):
        self.exported = []

    def export(self, session: SessionRef):
        self.exported.append(session)
        return ExportResult(ExportStatus.EXPORTED, session.session_id, "Exported", filename="thread.md", markdown="# Thread\n")


def post_json(url, payload, headers=None):
    data = json.dumps(payload).encode("utf-8")
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    request = urllib.request.Request(url, data=data, headers=request_headers, method="POST")
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.loads(response.read().decode("utf-8"))


def get_json(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {}, method="GET")
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.loads(response.read().decode("utf-8"))


def test_helper_server_delete_and_undo():
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service, allow_http_mutation=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.port}"
        deleted = post_json(base + "/delete", {"session_id": "s1", "title": "First"})
        undone = post_json(base + "/undo", {"undo_token": "u1"})
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert deleted["status"] == "local_deleted"
    assert deleted["undo_token"] == "u1"
    assert undone["status"] == "undone"
    assert service.deleted[0].session_id == "s1"
    assert service.undone == ["u1"]


def test_helper_server_resolves_archived_thread_by_title():
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service, allow_http_mutation=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.port}"
        resolved = post_json(base + "/archived-thread", {"title": "Codex Thread"})
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert resolved == {"session_id": "archived-t1", "title": "Codex Thread"}
    assert service.archived_title_queries == ["Codex Thread"]


def test_helper_server_exports_markdown_when_authorized():
    delete_service = FakeDeleteService()
    export_service = FakeExportService()
    server = HelperServer("127.0.0.1", 0, delete_service, export_service, allow_http_mutation=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.port}"
        exported = post_json(base + "/export-markdown", {"session_id": "s1", "title": "First"})
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert exported["status"] == "exported"
    assert exported["filename"] == "thread.md"
    assert export_service.exported[0].session_id == "s1"


def test_helper_server_rejects_http_mutation_by_default():
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.port}"
        try:
            post_json(base + "/delete", {"session_id": "s1", "title": "First"})
            assert False, "expected forbidden response"
        except urllib.error.HTTPError as exc:
            assert exc.code == 403
        try:
            post_json(base + "/export-markdown", {"session_id": "s1", "title": "First"})
            assert False, "expected forbidden response"
        except urllib.error.HTTPError as exc:
            assert exc.code == 403
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert service.deleted == []


def test_helper_server_accepts_http_mutation_token():
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service, http_mutation_token="test-token")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.port}"
        try:
            post_json(base + "/delete", {"session_id": "s1", "title": "First"})
            assert False, "expected forbidden response"
        except urllib.error.HTTPError as exc:
            assert exc.code == 403
        deleted = post_json(base + "/delete", {"session_id": "s1", "title": "First"}, {"X-Codex-Session-Delete-Token": "test-token"})
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert deleted["status"] == "local_deleted"
    assert service.deleted[0].session_id == "s1"


def test_helper_server_moves_thread_workspace_without_http_mutation_token():
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.port}"
        moved = post_json(base + "/move-thread-workspace", {"session_id": "s1", "title": "First", "target_cwd": "/project/a"})
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert moved == {"status": "moved", "session_id": "s1", "target_cwd": "/project/a"}


def test_helper_server_returns_thread_sort_key():
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.port}"
        sort_key = post_json(base + "/thread-sort-key", {"session_id": "s1", "title": "First"})
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert sort_key == {"status": "ok", "session_id": "s1", "updated_at_ms": 123}


def test_helper_server_returns_thread_sort_keys():
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.port}"
        sort_keys = post_json(base + "/thread-sort-keys", {"sessions": [{"session_id": "s1", "title": "First"}, {"session_id": "s2", "title": "Second"}]})
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert sort_keys == {"status": "ok", "sort_keys": [{"session_id": "s1", "updated_at_ms": 1}, {"session_id": "s2", "updated_at_ms": 2}]}


def test_helper_server_allows_private_network_preflight():
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        request = urllib.request.Request(
            f"http://127.0.0.1:{server.port}/delete",
            method="OPTIONS",
            headers={
                "Origin": "file://",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            private_network = response.headers.get("Access-Control-Allow-Private-Network")
            allow_headers = response.headers.get("Access-Control-Allow-Headers")
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert private_network == "true"
    assert "X-Codex-Session-Delete-Token" in allow_headers
    assert "X-Web-Token" in allow_headers



def test_remote_client_uses_header_auth_without_query_tokens():
    text = Path("codex_session_delete/static/app.js").read_text(encoding="utf-8")

    assert '"X-Web-Token": TOKEN' in text
    assert "new EventSource" not in text
    assert "authUrl(" not in text
    assert '"token=" +' not in text
    assert 'params.delete("token")' in text
    assert "window.history.replaceState" in text
    assert 'fetch("/api/remote/threads", { headers: authHeaders() })' in text
    assert 'fetch("/api/remote/dom-state", { headers: authHeaders()' in text


def test_remote_client_auto_opens_new_chat_after_thread_list_sync():
    text = Path("codex_session_delete/static/app.js").read_text(encoding="utf-8")

    assert "let pendingNewChat = null" in text
    assert "function rememberPendingNewChat()" in text
    assert "function maybeAutoOpenPendingNewChat(data)" in text
    assert "maybeAutoOpenPendingNewChat(data)" in text[text.index("async function loadThreadList"):text.index("function renderThreadList")]
    assert "knownThreadIds: new Set(flattenThreadsFromData" in text
    assert "navigateToThread(candidate.id, { auto: true })" in text
    assert "setTimeout(loadThreadList, 500)" in text


def test_remote_client_auto_follow_sets_web_active_thread_for_dom_updates():
    text = Path("codex_session_delete/static/app.js").read_text(encoding="utf-8")
    start = text.index("function handleDomState")
    end = text.index("\n\n  // --- Message rendering ---", start)
    handle_dom_state = text[start:end]

    assert "state.web_active_thread && state.web_active_thread === currentThreadId" in handle_dom_state
    assert "navigateToThread(state.active_thread_id, { auto: true, preserveMessages: true })" in handle_dom_state


def test_remote_client_scrolls_to_bottom_after_layout_settles():
    text = Path("codex_session_delete/static/app.js").read_text(encoding="utf-8")
    start = text.index("function scrollToBottom")
    end = text.index("\n\n  // --- Send message ---", start)
    scroll_code = text[start:end]

    assert "function applyScrollToBottom()" in scroll_code
    assert "messageListEl.scrollTop = messageListEl.scrollHeight" in scroll_code
    assert "requestAnimationFrame(applyScrollToBottom)" in scroll_code
    assert "setTimeout(applyScrollToBottom, 50)" in scroll_code
    assert "setTimeout(applyScrollToBottom, 200)" in scroll_code


def test_remote_client_prompts_for_completion_sound_permission():
    text = Path("codex_session_delete/static/app.js").read_text(encoding="utf-8")

    assert "function showAudioPermissionPrompt()" in text
    assert "启用任务完成提示音" in text
    assert "function enableSoundReminder()" in text
    assert 'localStorage.setItem("codexRemoteSoundEnabled", "1")' in text
    assert "window.AudioContext || window.webkitAudioContext" in text
    assert "requestNotificationPermission()" in text
    assert "showAudioPermissionPrompt();" in text[text.index("function init()"):text.index("\n\n  window.addEventListener")]


def test_remote_client_notifies_when_streaming_finishes_with_assistant_message():
    text = Path("codex_session_delete/static/app.js").read_text(encoding="utf-8")
    start = text.index("function handleDomState")
    end = text.index("\n\n  // --- Message rendering ---", start)
    remote_state_code = text[start:end]

    assert "maybeNotifyTaskCompleted(state, previousStreaming, previousThreadId)" in remote_state_code
    assert "lastRemoteStreaming = !!state.is_streaming" in remote_state_code
    assert "function maybeNotifyTaskCompleted" in remote_state_code
    assert "!previousStreaming || state.is_streaming" in remote_state_code
    assert "previousThreadId !== state.active_thread_id" in remote_state_code
    assert "lastAssistantMessage(state.messages || [])" in remote_state_code
    assert "showRemoteToast(\"任务已完成\", preview)" in remote_state_code
    assert "playCompletionSound()" in remote_state_code
    assert "showCompletionNotification(preview)" in remote_state_code


def test_remote_css_allows_message_list_to_be_scroll_container():
    text = Path("codex_session_delete/static/style.css").read_text(encoding="utf-8")

    assert ".chat-area{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;" in text
    assert ".message-list{flex:1;min-height:0;overflow-y:auto;" in text


def test_remote_css_styles_sound_permission_and_completion_toast():
    text = Path("codex_session_delete/static/style.css").read_text(encoding="utf-8")

    assert ".audio-permission-banner{" in text
    assert ".btn-audio-enable{" in text
    assert ".remote-toast{" in text
    assert ".remote-toast.visible{" in text
    assert "@keyframes remoteSlideUp" in text


def test_conversation_automation_uses_cdp_bridge_not_fetch_for_codex_csp():
    text = Path("codex_session_delete/inject/conversation-automation.js").read_text(encoding="utf-8")

    assert "window.__codexSessionDeleteBridge" in text
    assert "helperRequest(\"/api/pending\"" in text
    assert "helperRequest(\"/api/callback\"" in text
    assert "helperRequest(\"/api/dom-report\"" in text
    assert "HELPER_BASE" not in text
    assert "`${HELPER_BASE}" not in text
    assert "nativeRequest.call(window, input, init)" in text


def test_conversation_automation_uses_project_new_chat_button_when_cwd_is_selected():
    text = Path("codex_session_delete/inject/conversation-automation.js").read_text(encoding="utf-8")

    assert "function findProjectNewChatButton(cwd)" in text
    assert "data-app-action-sidebar-project-row" in text
    assert "data-app-action-sidebar-project-id" in text
    assert "workspacePathMatches(projectId, cwd)" in text
    assert "开始新对话|新对话|new chat|start" in text
    assert "findProjectNewChatButton(cwd) || findNewChatButton()" in text


def test_conversation_automation_clears_old_timers_and_shields_legacy_fetch_errors():
    text = Path("codex_session_delete/inject/conversation-automation.js").read_text(encoding="utf-8")

    assert "__codexConversationAutomationTimers.forEach((timer) => clearInterval(timer))" in text
    assert "console.clear()" in text
    assert "__codexConversationNativeFetch" in text
    assert "window.fetch = async function codexConversationHelperRequestShield" in text
    assert 'path === "/api/pending"' in text
    assert "jsonResponse({ messages: [] })" in text


def test_conversation_automation_updates_prosemirror_state_before_submit():
    text = Path("codex_session_delete/inject/conversation-automation.js").read_text(encoding="utf-8")

    assert 'div[contenteditable="true"][data-codex-composer="true"]' in text
    assert 'div.ProseMirror[contenteditable="true"]' in text
    assert "function selectEditableContents(el)" in text
    assert 'document.execCommand("insertText", false, prompt)' in text
    assert "range.selectNodeContents(el)" in text


def test_conversation_automation_submits_from_composer_root_not_first_svg_button():
    text = Path("codex_session_delete/inject/conversation-automation.js").read_text(encoding="utf-8")

    assert "function findComposerRoot()" in text
    assert "function findSubmitButton()" in text
    assert "const root = findComposerRoot()" in text
    assert "const buttons = Array.from(root.querySelectorAll(\"button\"))" in text
    assert "for (let i = buttons.length - 1; i >= 0; i--)" in text
    assert "stop|停止|添加|文件|权限|access|model|模型" in text
    assert 'if ((btn.textContent || "").trim()) continue' in text
    assert "btn.querySelector(\"svg\")" in text


def test_conversation_automation_waits_for_submit_button_after_input():
    text = Path("codex_session_delete/inject/conversation-automation.js").read_text(encoding="utf-8")

    assert "for (let attempt = 0; attempt < 20; attempt++)" in text
    assert "const submitBtn = findSubmitButton()" in text
    assert "await new Promise(r => setTimeout(r, 150))" in text
    assert 'reportResult(msgId, "error", "Cannot find enabled submit button")' in text


def test_remote_threads_route_accepts_header_token(tmp_path):
    db_path = tmp_path / "state.sqlite"
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)")
        db.execute("INSERT INTO sessions VALUES (?, ?)", ("s1", "Header Token"))

    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    server.web_token = "test-token"
    server.db_path = db_path
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        data = get_json(f"http://127.0.0.1:{server.port}/api/remote/threads", {"X-Web-Token": "test-token"})
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert data["ungrouped"][0] == {"id": "s1", "title": "Header Token"}

def test_remote_threads_route_accepts_token_query_string(tmp_path):
    db_path = tmp_path / "state.sqlite"
    with sqlite3.connect(db_path) as db:
        db.execute(
            "CREATE TABLE threads ("
            "id TEXT PRIMARY KEY, title TEXT, cwd TEXT, archived INTEGER, "
            "updated_at_ms INTEGER, created_at_ms INTEGER)"
        )
        db.execute(
            "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)",
            ("t1", "First", "/workspace/project-a", 0, 1700000000000, 1699999999000),
        )

    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    server.web_token = "test-token"
    server.db_path = db_path
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        data = get_json(f"http://127.0.0.1:{server.port}/api/remote/threads?token=test-token")
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert data["projects"]["project-a"][0]["id"] == "t1"


def test_remote_threads_route_prefers_session_index_title_over_db_first_prompt(tmp_path):
    db_path = tmp_path / "state.sqlite"
    session_index_path = tmp_path / "session_index.jsonl"
    session_index_path.write_text(
        '{"id":"t1","thread_name":"修复远程线程标题","updated_at":"2026-05-14T06:09:54.027412Z"}\n',
        encoding="utf-8",
    )
    with sqlite3.connect(db_path) as db:
        db.execute(
            "CREATE TABLE threads ("
            "id TEXT PRIMARY KEY, title TEXT, cwd TEXT, archived INTEGER, "
            "updated_at_ms INTEGER, created_at_ms INTEGER)"
        )
        db.execute(
            "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)",
            (
                "t1",
                "现在/api/remote/threads获取到的数据中的title不对，现在的title是用户说的第一句话，不是真正的title，修复下",
                "/workspace/project-a",
                0,
                1700000000000,
                1699999999000,
            ),
        )

    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    server.web_token = "test-token"
    server.db_path = db_path
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        data = get_json(f"http://127.0.0.1:{server.port}/api/remote/threads?token=test-token")
    finally:
        server.shutdown()
        thread.join(timeout=3)

    entry = data["projects"]["project-a"][0]
    assert entry["title"] == "修复远程线程标题"


def test_remote_post_route_accepts_token_query_string():
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    server.web_token = "test-token"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        sent = post_json(f"http://127.0.0.1:{server.port}/api/remote/send?token=test-token", {"prompt": "hello"})
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert sent == {"ok": True, "id": "1"}



def test_remote_new_chat_route_accepts_token_query_string():
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    server.web_token = "test-token"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = post_json(f"http://127.0.0.1:{server.port}/api/remote/new-chat?token=test-token", {})
    finally:
        server.shutdown()
        thread.join(timeout=3)

    assert result["ok"] is True
    assert "id" in result

def test_cdp_evaluate_returns_without_reentrant_lock_deadlock(monkeypatch):
    service = FakeDeleteService()
    server = HelperServer("127.0.0.1", 0, service)
    server.cdp_websocket_url = "ws://codex-page"
    socket = Mock()
    socket.recv.return_value = json.dumps({"id": 1001, "result": {"result": {"value": {"status": "ok"}}}})
    monkeypatch.setattr("codex_session_delete.helper_server.websocket.create_connection", lambda *args, **kwargs: socket)
    result: dict[str, object] = {}

    thread = threading.Thread(target=lambda: result.update(value=server.cdp_evaluate("1 + 1")), daemon=True)
    thread.start()
    thread.join(timeout=0.5)
    try:
        assert not thread.is_alive()
        assert result["value"] == {"status": "ok"}
    finally:
        server.server_close()
