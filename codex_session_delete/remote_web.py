from __future__ import annotations

import json
import mimetypes
import secrets
import sqlite3
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

STATIC_DIR = Path(__file__).parent / "static"

_MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
}


def generate_web_token() -> str:
    return secrets.token_urlsafe(32)


def validate_token(path: str, headers: dict[str, str], expected_token: str) -> bool:
    parsed = urllib.parse.urlparse(path)
    params = urllib.parse.parse_qs(parsed.query)
    query_token = params.get("token", [None])[0]
    header_token = headers.get("X-Web-Token")
    return (query_token == expected_token) or (header_token == expected_token)


def serve_static_file(wfile: Any, path: str) -> bool:
    if ".." in path:
        return False
    rel = path.lstrip("/")
    if rel.startswith("static/"):
        rel = rel[len("static/"):]
    if not rel:
        rel = "index.html"
    file_path = STATIC_DIR / rel
    if not file_path.is_file():
        return False
    content = file_path.read_bytes()
    content_type = _MIME_TYPES.get(file_path.suffix) or mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    header = (
        f"HTTP/1.1 200 OK\r\n"
        f"Content-Type: {content_type}\r\n"
        f"Content-Length: {len(content)}\r\n"
        f"Cache-Control: public, max-age=60\r\n"
        f"Access-Control-Allow-Origin: *\r\n"
        f"\r\n"
    )
    wfile.write(header.encode("utf-8"))
    wfile.write(content)
    return True


def serve_remote_index(wfile: Any, token: str) -> None:
    index_path = STATIC_DIR / "index.html"
    if not index_path.is_file():
        error = b"<!DOCTYPE html><h1>Web UI not found</h1>"
        header = (
            f"HTTP/1.1 404 Not Found\r\n"
            f"Content-Type: text/html; charset=utf-8\r\n"
            f"Content-Length: {len(error)}\r\n"
            f"\r\n"
        )
        wfile.write(header.encode("utf-8"))
        wfile.write(error)
        return
    html = index_path.read_text(encoding="utf-8")
    content = html.encode("utf-8")
    header = (
        f"HTTP/1.1 200 OK\r\n"
        f"Content-Type: text/html; charset=utf-8\r\n"
        f"Content-Length: {len(content)}\r\n"
        f"Access-Control-Allow-Origin: *\r\n"
        f"\r\n"
    )
    wfile.write(header.encode("utf-8"))
    wfile.write(content)


class DomStateStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {
            "active_thread_id": None,
            "web_active_thread": None,
            "messages": [],
            "is_streaming": False,
            "streaming_content": "",
        }
        self._version: int = 0
        self._events: list[threading.Event] = []

    def update(self, new_state: dict[str, Any]) -> int:
        with self._lock:
            self._state.update(new_state)
            self._version += 1
            for ev in self._events:
                ev.set()
            return self._version

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {**self._state, "version": self._version}

    def subscribe(self) -> tuple[threading.Event, int]:
        ev = threading.Event()
        with self._lock:
            self._events.append(ev)
            return ev, self._version

    def unsubscribe(self, ev: threading.Event) -> None:
        with self._lock:
            self._events = [e for e in self._events if e is not ev]


class RolloutWatcher:
    """后台轮询 rollout 文件，检测到新完整消息后推送到 dom_state_store。"""

    POLL_INTERVAL = 2.0

    def __init__(self, store: DomStateStore) -> None:
        self._store = store
        self._lock = threading.Lock()
        self._thread_id: str | None = None
        self._rollout_path: Path | None = None
        self._last_count = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def watch(self, thread_id: str, rollout_path: Path, current_count: int) -> None:
        with self._lock:
            self._thread_id = thread_id
            self._rollout_path = rollout_path
            self._last_count = current_count

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            self._stop.wait(self.POLL_INTERVAL)
            if self._stop.is_set():
                break
            with self._lock:
                tid = self._thread_id
                rp = self._rollout_path
                last = self._last_count
            if not tid or not rp or not rp.is_file():
                continue
            # web 用户已切换到其他线程，跳过
            if self._store._state.get("web_active_thread") != tid:
                continue
            try:
                messages = _load_messages_from_rollout(rp)
            except Exception:
                continue
            if len(messages) <= last:
                continue
            with self._lock:
                self._last_count = len(messages)
            self._store.update({
                "messages": messages,
                "is_streaming": False,
                "streaming_content": "",
            })


def _load_messages_from_rollout(rollout_path: Path) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    try:
        with rollout_path.open("r", encoding="utf-8") as handle:
            for raw_line in handle:
                if not raw_line.strip():
                    continue
                event = json.loads(raw_line)
                if event.get("type") != "response_item":
                    continue
                payload = event.get("payload")
                if not isinstance(payload, dict) or payload.get("type") != "message":
                    continue
                role = payload.get("role")
                if role not in {"user", "assistant"}:
                    continue
                content = payload.get("content")
                if not isinstance(content, list):
                    continue
                texts: list[str] = []
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") in {"input_text", "output_text"}:
                        text = str(block.get("text") or "").strip()
                        if text:
                            texts.append(text)
                body = "\n\n".join(texts).strip()
                if body:
                    messages.append({"role": role, "content": body})
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return messages


def _build_fallback_state(db_path: Path) -> dict[str, Any]:
    state: dict[str, Any] = {
        "active_thread_id": None,
        "messages": [],
        "is_streaming": False,
        "streaming_content": "",
    }
    if not db_path.exists():
        return state
    try:
        with sqlite3.connect(str(db_path)) as db:
            db.row_factory = sqlite3.Row
            cols = {r[1] for r in db.execute("PRAGMA table_info(threads)").fetchall()}
            has_rollout = "rollout_path" in cols
            has_updated_ms = "updated_at_ms" in cols
            select = "SELECT id"
            if has_rollout:
                select += ", rollout_path"
            select += " FROM threads"
            if has_updated_ms:
                select += " ORDER BY updated_at_ms DESC"
            select += " LIMIT 1"
            row = db.execute(select).fetchone()
            if row is None:
                row = db.execute("SELECT id FROM sessions LIMIT 1").fetchone()
                if row:
                    state["active_thread_id"] = str(row["id"])
                return state
            state["active_thread_id"] = str(row["id"])
            if has_rollout:
                rollout_path = str(row["rollout_path"] or "")
                if rollout_path:
                    rp = Path(rollout_path)
                    if rp.is_file():
                        state["messages"] = _load_messages_from_rollout(rp)
    except (sqlite3.Error, OSError):
        pass
    return state


def handle_sse(handler: Any, store: DomStateStore, token: str, db_path: Path | None = None) -> None:
    ev, last_version = store.subscribe()
    try:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Connection", "keep-alive")
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.send_header("X-Accel-Buffering", "no")
        handler.end_headers()

        snapshot = store.snapshot()
        if not snapshot.get("messages") and db_path:
            fallback = _build_fallback_state(db_path)
            if fallback["messages"]:
                if not snapshot.get("active_thread_id"):
                    snapshot["active_thread_id"] = fallback["active_thread_id"]
                snapshot["messages"] = fallback["messages"]
        data = json.dumps(snapshot, ensure_ascii=False)
        handler.wfile.write(f"data: {data}\n\n".encode("utf-8"))
        handler.wfile.flush()
        last_version = snapshot["version"]

        while True:
            ev.wait(timeout=30)
            ev.clear()
            if handler.wfile.closed:
                break
            snap = store.snapshot()
            if snap["version"] == last_version:
                handler.wfile.write(b": heartbeat\n\n")
                handler.wfile.flush()
                continue
            data = json.dumps(snap, ensure_ascii=False)
            handler.wfile.write(f"data: {data}\n\n".encode("utf-8"))
            handler.wfile.flush()
            last_version = snap["version"]
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        store.unsubscribe(ev)
