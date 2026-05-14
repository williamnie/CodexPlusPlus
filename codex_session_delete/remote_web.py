from __future__ import annotations

import json
import mimetypes
import secrets
import threading
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


def handle_sse(handler: Any, store: DomStateStore, token: str) -> None:
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
