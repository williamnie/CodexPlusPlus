from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from typing import Protocol
from urllib.parse import unquote
from urllib.request import Request, urlopen

import websocket

from codex_session_delete.models import DeleteResult, DeleteStatus, ExportResult, ExportStatus, SessionRef

DEFAULT_AD_LIST_URLS = [
    "https://raw.githubusercontent.com/BigPizzaV3/Ad-List/main/ads.json",
    "https://cdn.jsdelivr.net/gh/BigPizzaV3/Ad-List@main/ads.json",
]


def fetch_ad_list(urls: list[str] | None = None) -> dict[str, object]:
    last_error: Exception | None = None
    for url in urls or DEFAULT_AD_LIST_URLS:
        try:
            request = Request(url, headers={"User-Agent": "CodexPlusPlus"})
            with urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            last_error = exc
    raise last_error or RuntimeError("ad list unavailable")


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
        ad_list_url: str = "https://raw.githubusercontent.com/BigPizzaV3/Ad-List/main/ads.json",
        ad_list_backup_urls: list[str] | None = None,
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
        self.ad_list_urls = [ad_list_url, *(ad_list_backup_urls or DEFAULT_AD_LIST_URLS[1:])]
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
                msg_id = self._next_cdp_id()
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

    def do_OPTIONS(self) -> None:
        self._send_json({"ok": True})

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json({"ok": True})
            return
        if self.path == "/api/pending":
            msgs = list(self.server.pending_messages)
            self.server.pending_messages.clear()
            self._send_json({"messages": msgs})
            return
        if self.path.startswith("/api/result/"):
            msg_id = self.path[len("/api/result/"):]
            result = self.server.get_result(msg_id)
            if result:
                self._send_json(result)
            else:
                pending = any(m["id"] == msg_id for m in self.server.pending_messages)
                self._send_json({"status": "pending" if pending else "not_found", "content": ""})
            return
        if self.path == "/ads":
            self._send_ads()
            return
        if self.path.startswith("/assets/"):
            self._send_asset(self.path.removeprefix("/assets/"))
            return
        self._send_json({"error": "not found"}, status=404)

    def do_POST(self) -> None:
        try:
            payload = self._read_json()
            if self.path in {"/delete", "/undo", "/archived-thread", "/export-markdown"} and not self._is_mutation_authorized():
                self._send_json({"error": "forbidden"}, status=403)
                return
            if self.path == "/api/send":
                prompt = str(payload.get("prompt", ""))
                if not prompt.strip():
                    self._send_json({"error": "empty prompt"}, status=400)
                    return
                msg_id = self.server.send_message(prompt)
                self._send_json({"ok": True, "id": msg_id})
                return
            if self.path == "/api/callback":
                msg_id = str(payload.get("id", ""))
                status = str(payload.get("status", "success"))
                content = str(payload.get("content", ""))
                self.server.store_result(msg_id, status, content)
                self._send_json({"ok": True})
                return
            if self.path == "/delete":
                session = SessionRef(session_id=str(payload.get("session_id", "")), title=str(payload.get("title", "")))
                self._send_json(self.server.service.delete(session).to_dict())
                return
            if self.path == "/undo":
                token = str(payload.get("undo_token", ""))
                self._send_json(self.server.service.undo(token).to_dict())
                return
            if self.path == "/export-markdown":
                if self.server.export_service is None:
                    self._send_json(
                        ExportResult(ExportStatus.FAILED, str(payload.get("session_id", "")), "Markdown 导出不可用").to_dict(),
                        status=400,
                    )
                    return
                session = SessionRef(session_id=str(payload.get("session_id", "")), title=str(payload.get("title", "")))
                self._send_json(self.server.export_service.export(session).to_dict())
                return
            if self.path == "/archived-thread":
                session = self.server.service.find_archived_thread_by_title(str(payload.get("title", "")))
                self._send_json({"session_id": session.session_id, "title": session.title} if session else {"session_id": "", "title": ""})
                return
            if self.path == "/move-thread-workspace":
                session = SessionRef(session_id=str(payload.get("session_id", "")), title=str(payload.get("title", "")))
                self._send_json(self.server.service.move_thread_workspace(session, str(payload.get("target_cwd", ""))))
                return
            if self.path == "/thread-sort-key":
                session = SessionRef(session_id=str(payload.get("session_id", "")), title=str(payload.get("title", "")))
                self._send_json(self.server.service.thread_sort_key(session))
                return
            if self.path == "/thread-sort-keys":
                raw_sessions = payload.get("sessions", [])
                sessions = [
                    SessionRef(session_id=str(item.get("session_id", "")), title=str(item.get("title", "")))
                    for item in raw_sessions
                    if isinstance(item, dict)
                ] if isinstance(raw_sessions, list) else []
                self._send_json(self.server.service.thread_sort_keys(sessions))
                return
            self._send_json({"error": "not found"}, status=404)
        except Exception as exc:
            session_id = str(payload.get("session_id", "")) if "payload" in locals() else ""
            if self.path == "/export-markdown":
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

    def _send_json(self, payload: dict[str, object], status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Codex-Session-Delete-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_ads(self) -> None:
        self._send_json(fetch_ad_list(self.server.ad_list_urls))

    def _send_asset(self, name: str) -> None:
        asset_name = unquote(name)
        if asset_name not in {"sponsor-alipay.jpg", "sponsor-wechat.jpg", "rawchat-sponsor.jpg"}:
            self._send_json({"error": "not found"}, status=404)
            return
        data = resources.files("codex_session_delete").joinpath("assets", asset_name).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
