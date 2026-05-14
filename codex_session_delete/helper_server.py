from __future__ import annotations

import json
import os
import sqlite3
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Protocol

import websocket

from codex_session_delete.models import DeleteResult, DeleteStatus, ExportResult, ExportStatus, SessionRef
from codex_session_delete.remote_web import DomStateStore, handle_sse, serve_remote_index, serve_static_file, validate_token


class DeleteService(Protocol):
    def delete(self, session: SessionRef) -> DeleteResult: ...
    def undo(self, token: str) -> DeleteResult: ...
    def find_archived_thread_by_title(self, title: str) -> SessionRef | None: ...
    def move_thread_workspace(self, session: SessionRef, target_cwd: str) -> dict[str, object]: ...
    def thread_sort_key(self, session: SessionRef) -> dict[str, object]: ...
    def thread_sort_keys(self, sessions: list[SessionRef]) -> dict[str, object]: ...


class ExportService(Protocol):
    def export(self, session: SessionRef) -> ExportResult: ...


class HelperServer(ThreadingHTTPServer):
    def __init__(
        self,
        host: str,
        port: int,
        service: DeleteService,
        export_service: ExportService | None = None,
        *,
        allow_http_mutation: bool = False,
        http_mutation_token: str | None = None,
    ):
        self.service = service
        self.export_service = export_service
        self.allow_http_mutation = allow_http_mutation
        self.http_mutation_token = http_mutation_token
        self.cdp_websocket_url: str | None = None
        self._cdp_lock = threading.Lock()
        self._cdp_msg_id = 1000
        self._msg_seq = 0
        self._msg_seq_lock = threading.Lock()
        self.pending_messages: list[dict[str, str]] = []
        self.results: dict[str, dict[str, str]] = {}
        self.web_token: str | None = None
        self.db_path: Path | None = None
        self.dom_state_store = DomStateStore()
        super().__init__((host, port), _Handler)

    @property
    def port(self) -> int:
        return int(self.server_address[1])

    def _next_cdp_id(self) -> int:
        with self._cdp_lock:
            self._cdp_msg_id += 1
            return self._cdp_msg_id

    def cdp_evaluate(self, script: str, timeout: int = 5) -> object | None:
        if not self.cdp_websocket_url:
            return None
        with self._cdp_lock:
            ws = websocket.create_connection(self.cdp_websocket_url, timeout=timeout)
            try:
                self._cdp_msg_id += 1
                msg_id = self._cdp_msg_id
                ws.send(json.dumps({
                    "id": msg_id,
                    "method": "Runtime.evaluate",
                    "params": {"expression": script, "awaitPromise": False, "returnByValue": True, "allowUnsafeEvalBlockedByCSP": True},
                }))
                while True:
                    message = json.loads(ws.recv())
                    if message.get("id") == msg_id:
                        if "error" in message:
                            return None
                        return (message.get("result") or {}).get("result", {}).get("value")
            finally:
                ws.close()

    def send_message(self, prompt: str) -> str:
        with self._msg_seq_lock:
            self._msg_seq += 1
            msg_id = str(self._msg_seq)
        self.pending_messages.append({"id": msg_id, "prompt": prompt})
        return msg_id

    def get_result(self, msg_id: str) -> dict[str, str] | None:
        return self.results.get(msg_id)

    def store_result(self, msg_id: str, status: str, content: str) -> None:
        self.results[msg_id] = {"status": status, "content": content}

    def inject_automation(self) -> bool:
        if not self.cdp_websocket_url:
            return False
        script_path = Path(__file__).parent / "inject" / "conversation-automation.js"
        if not script_path.exists():
            return False
        helper_url = f"http://127.0.0.1:{self.port}"
        prefix = f"window.__CODEX_SESSION_DELETE_HELPER__ = '{helper_url}';\n"
        script = prefix + script_path.read_text(encoding="utf-8")
        self.cdp_evaluate(script)
        return True


class _Handler(BaseHTTPRequestHandler):
    server: HelperServer

    @property
    def route_path(self) -> str:
        return urllib.parse.urlparse(self.path).path

    def do_OPTIONS(self) -> None:
        self._send_json({"ok": True})

    def do_GET(self) -> None:
        path = self.route_path
        if path == "/health":
            self._send_json({"ok": True})
            return
        if path == "/api/pending":
            msgs = list(self.server.pending_messages)
            self.server.pending_messages.clear()
            self._send_json({"messages": msgs})
            return
        if path.startswith("/api/result/"):
            msg_id = path[len("/api/result/"):]
            result = self.server.get_result(msg_id)
            if result:
                self._send_json(result)
            else:
                pending = any(m["id"] == msg_id for m in self.server.pending_messages)
                self._send_json({"status": "pending" if pending else "not_found", "content": ""})
            return
        # --- Remote Desktop routes ---
        if path == "/" or path.startswith("/remote"):
            if self.server.web_token:
                serve_remote_index(self.wfile, self.server.web_token)
            else:
                serve_remote_index(self.wfile, "")
            return
        if path.startswith("/static/"):
            if serve_static_file(self.wfile, path):
                return
            self._send_json({"error": "not found"}, status=404)
            return
        if path.startswith("/api/remote/dom-state"):
            if not self._check_web_token():
                self._send_json({"error": "unauthorized"}, status=401)
                return
            handle_sse(self, self.server.dom_state_store, self.server.web_token or "")
            return
        if path == "/api/remote/dom-snapshot":
            if not self._check_web_token():
                self._send_json({"error": "unauthorized"}, status=401)
                return
            self._send_json(self.server.dom_state_store.snapshot())
            return
        if path == "/api/remote/threads":
            if not self._check_web_token():
                self._send_json({"error": "unauthorized"}, status=401)
                return
            self._serve_thread_list()
            return
        self._send_json({"error": "not found"}, status=404)

    def do_POST(self) -> None:
        try:
            path = self.route_path
            payload = self._read_json()
            if path in {"/delete", "/undo", "/archived-thread", "/export-markdown"} and not self._is_mutation_authorized():
                self._send_json({"error": "forbidden"}, status=403)
                return
            if path == "/api/send":
                prompt = str(payload.get("prompt", ""))
                if not prompt.strip():
                    self._send_json({"error": "empty prompt"}, status=400)
                    return
                msg_id = self.server.send_message(prompt)
                self._send_json({"ok": True, "id": msg_id})
                return
            if path == "/api/callback":
                msg_id = str(payload.get("id", ""))
                status = str(payload.get("status", "success"))
                content = str(payload.get("content", ""))
                self.server.store_result(msg_id, status, content)
                self._send_json({"ok": True})
                return
            if path == "/delete":
                session = SessionRef(session_id=str(payload.get("session_id", "")), title=str(payload.get("title", "")))
                self._send_json(self.server.service.delete(session).to_dict())
                return
            if path == "/undo":
                token = str(payload.get("undo_token", ""))
                self._send_json(self.server.service.undo(token).to_dict())
                return
            if path == "/export-markdown":
                if self.server.export_service is None:
                    self._send_json(
                        ExportResult(ExportStatus.FAILED, str(payload.get("session_id", "")), "Markdown 导出不可用").to_dict(),
                        status=400,
                    )
                    return
                session = SessionRef(session_id=str(payload.get("session_id", "")), title=str(payload.get("title", "")))
                self._send_json(self.server.export_service.export(session).to_dict())
                return
            if path == "/archived-thread":
                session = self.server.service.find_archived_thread_by_title(str(payload.get("title", "")))
                self._send_json({"session_id": session.session_id, "title": session.title} if session else {"session_id": "", "title": ""})
                return
            if path == "/move-thread-workspace":
                session = SessionRef(session_id=str(payload.get("session_id", "")), title=str(payload.get("title", "")))
                self._send_json(self.server.service.move_thread_workspace(session, str(payload.get("target_cwd", ""))))
                return
            if path == "/thread-sort-key":
                session = SessionRef(session_id=str(payload.get("session_id", "")), title=str(payload.get("title", "")))
                self._send_json(self.server.service.thread_sort_key(session))
                return
            if path == "/thread-sort-keys":
                raw_sessions = payload.get("sessions", [])
                sessions = [
                    SessionRef(session_id=str(item.get("session_id", "")), title=str(item.get("title", "")))
                    for item in raw_sessions
                    if isinstance(item, dict)
                ] if isinstance(raw_sessions, list) else []
                self._send_json(self.server.service.thread_sort_keys(sessions))
                return
            # --- Remote Desktop POST routes ---
            if path == "/api/dom-report":
                if self.client_address[0] not in ("127.0.0.1", "::1"):
                    self._send_json({"error": "forbidden"}, status=403)
                    return
                self.server.dom_state_store.update(payload)
                self._send_json({"ok": True})
                return
            if path == "/api/remote/navigate":
                if not self._check_web_token():
                    self._send_json({"error": "unauthorized"}, status=401)
                    return
                thread_id = str(payload.get("thread_id", ""))
                script = (
                    '(() => {'
                    f'const row = document.querySelector(\'[data-app-action-sidebar-thread-id="{thread_id}"]\');'
                    'if (!row) return {status: "not_found"};'
                    'const link = row.querySelector("a") || row;'
                    'link.click();'
                    f'return {{status: "ok", thread_id: "{thread_id}"}};'
                    '})()'
                )
                result = self.server.cdp_evaluate(script)
                self._send_json(result if isinstance(result, dict) else {"status": "cdp_unavailable"})
                return
            if path == "/api/remote/send":
                if not self._check_web_token():
                    self._send_json({"error": "unauthorized"}, status=401)
                    return
                prompt = str(payload.get("prompt", ""))
                if not prompt.strip():
                    self._send_json({"error": "empty prompt"}, status=400)
                    return
                msg_id = self.server.send_message(prompt)
                self._send_json({"ok": True, "id": msg_id})
                return
            if path == "/api/remote/new-chat":
                if not self._check_web_token():
                    self._send_json({"error": "unauthorized"}, status=401)
                    return
                script = (
                    '(() => {'
                    'const sels = [\'button[aria-label="New chat"]\',\'button[aria-label="新对话"]\',\'button[aria-label="New Chat"]\'];'
                    'for (const s of sels) { const b = document.querySelector(s); if (b) { b.click(); return {status: "ok"}; } }'
                    'return {status: "not_found"};'
                    '})()'
                )
                result = self.server.cdp_evaluate(script)
                self._send_json(result if isinstance(result, dict) else {"status": "cdp_unavailable"})
                return
            self._send_json({"error": "not found"}, status=404)
        except Exception as exc:
            session_id = str(payload.get("session_id", "")) if "payload" in locals() else ""
            if self.route_path == "/export-markdown":
                result = ExportResult(ExportStatus.FAILED, session_id, str(exc))
                self._send_json(result.to_dict(), status=400)
                return
            result = DeleteResult(DeleteStatus.FAILED, session_id, str(exc))
            self._send_json(result.to_dict(), status=400)

    def log_message(self, format: str, *args: object) -> None:
        return

    def _read_json(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        return json.loads(raw)

    def _is_mutation_authorized(self) -> bool:
        if self.server.allow_http_mutation:
            return True
        token = self.server.http_mutation_token
        return bool(token and self.headers.get("X-Codex-Session-Delete-Token") == token)

    def _check_web_token(self) -> bool:
        if not self.server.web_token:
            return False
        if self.client_address[0] in ("127.0.0.1", "::1"):
            return True
        headers = {k: v for k, v in self.headers.items()}
        return validate_token(self.path, headers, self.server.web_token)

    def _serve_thread_list(self) -> None:
        db_path = self.server.db_path
        if db_path is None or not db_path.exists():
            self._send_json({"projects": {}, "ungrouped": []})
            return
        try:
            with sqlite3.connect(str(db_path)) as db:
                db.row_factory = sqlite3.Row
                kind = None
                for tbl in ("threads", "sessions"):
                    try:
                        db.execute(f"SELECT count(*) FROM {tbl}")
                        kind = tbl
                        break
                    except sqlite3.OperationalError:
                        continue
                if kind == "threads":
                    cols = {r[1] for r in db.execute("PRAGMA table_info(threads)").fetchall()}
                    has_archived = "archived" in cols
                    has_cwd = "cwd" in cols
                    has_updated_ms = "updated_at_ms" in cols
                    has_created_ms = "created_at_ms" in cols
                    select = "SELECT id, title"
                    if has_cwd:
                        select += ", cwd"
                    if has_updated_ms:
                        select += ", updated_at_ms"
                    if has_created_ms:
                        select += ", created_at_ms"
                    select += " FROM threads"
                    if has_archived:
                        select += " WHERE archived != 1"
                    if has_updated_ms:
                        select += " ORDER BY updated_at_ms DESC"
                    elif has_created_ms:
                        select += " ORDER BY created_at_ms DESC"
                    rows = db.execute(select).fetchall()
                elif kind == "sessions":
                    rows = db.execute("SELECT id, title FROM sessions").fetchall()
                else:
                    rows = []
        except Exception:
            self._send_json({"projects": {}, "ungrouped": []})
            return

        index_titles = self._session_index_thread_titles(db_path) if kind == "threads" else {}
        projects: dict[str, list[dict[str, object]]] = {}
        ungrouped: list[dict[str, object]] = []

        for row in rows:
            row_id = str(row["id"])
            title = index_titles.get(row_id) or row["title"] or ""
            entry: dict[str, object] = {"id": row_id, "title": title}
            if "cwd" in row.keys() and row["cwd"]:
                entry["cwd"] = row["cwd"]
            if "updated_at_ms" in row.keys() and row["updated_at_ms"]:
                entry["updated_at_ms"] = row["updated_at_ms"]
            if "created_at_ms" in row.keys() and row["created_at_ms"]:
                entry["created_at_ms"] = row["created_at_ms"]
            cwd = entry.get("cwd")
            if cwd:
                label = os.path.basename(str(cwd)) or str(cwd)
                projects.setdefault(label, []).append(entry)
            else:
                ungrouped.append(entry)

        self._send_json({"projects": projects, "ungrouped": ungrouped})

    def _session_index_thread_titles(self, db_path: Path) -> dict[str, str]:
        path = db_path.parent / "session_index.jsonl"
        if not path.is_file():
            return {}

        titles: dict[str, str] = {}
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(item, dict):
                        continue
                    thread_id = str(item.get("id") or "").strip()
                    title = str(item.get("thread_name") or "").strip()
                    if thread_id and title:
                        titles[thread_id] = title
        except OSError:
            return {}
        return titles

    def _send_json(self, payload: dict[str, object], status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Codex-Session-Delete-Token, X-Web-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
