#!/usr/bin/env python3
"""Local disk usage browser. Moves files to the Trash and never deletes them."""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import threading
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HOME = Path.home().resolve()
APP_ROOT = Path(__file__).resolve().parent
TOKEN = secrets.token_urlsafe(32)
MAX_TRASH = 200
PROTECTED = (
    HOME / ".ssh",
    HOME / ".gnupg",
    HOME / "Library" / "Keychains",
    APP_ROOT,
)


class ScanSlot:
    """One running du/find. A newer request cancels the previous one."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._token = 0
        self._procs: list[subprocess.Popen[str] | subprocess.Popen[bytes]] = []

    def start(self) -> int:
        with self._lock:
            self._token += 1
            procs = self._procs
            self._procs = []
            token = self._token
        for proc in procs:
            _kill(proc)
        return token

    def bind(self, token: int, proc: subprocess.Popen[str] | subprocess.Popen[bytes]) -> bool:
        with self._lock:
            if token != self._token:
                _kill(proc)
                return False
            self._procs.append(proc)
            return True

    def release(self, proc: subprocess.Popen[str] | subprocess.Popen[bytes]) -> None:
        with self._lock:
            if proc in self._procs:
                self._procs.remove(proc)

    def current(self, token: int) -> bool:
        with self._lock:
            return token == self._token


SCANS = ScanSlot()
CACHE: dict[str, tuple[int, dict]] = {}
CACHE_LOCK = threading.Lock()


def _kill(proc: subprocess.Popen[str] | subprocess.Popen[bytes] | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.kill()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


def inside_home(path: Path) -> bool:
    try:
        path.resolve().relative_to(HOME)
        return True
    except ValueError:
        return False


def lexical_home_path(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError("Нужен абсолютный путь")
    absolute = Path(os.path.abspath(path))
    if not inside_home(absolute):
        raise PermissionError("Путь вне домашнего каталога")
    return absolute


def resolved_home_path(raw: str) -> Path:
    absolute = lexical_home_path(raw)
    resolved = absolute.resolve()
    if not inside_home(resolved):
        raise PermissionError("Путь вне домашнего каталога")
    return resolved


def _identity(path: Path) -> tuple[int, int]:
    stat = path.lstat()
    return stat.st_dev, stat.st_ino


def _is_same(path: Path, root: Path) -> bool:
    try:
        return _identity(path) == _identity(root)
    except OSError:
        return False


def _is_inside(path: Path, root: Path) -> bool:
    current = path
    seen: set[tuple[int, int]] = set()
    while True:
        try:
            identity = _identity(current)
        except OSError:
            return False
        if identity in seen:
            return False
        seen.add(identity)
        if _is_same(current, root):
            return True
        parent = current.parent
        if parent == current:
            return False
        current = parent


def trash_block_reason(path: Path) -> str | None:
    resolved = path.resolve() if path.exists() or path.is_symlink() else path
    if not inside_home(path) or not inside_home(resolved):
        return "Путь вне домашнего каталога"
    if _is_same(path, HOME) or _is_same(resolved, HOME):
        return "Домашний каталог нельзя убирать в Корзину"
    for protected in PROTECTED:
        if _is_inside(path, protected) or _is_inside(resolved, protected):
            return "Этот путь защищён"
    return None


def applescript_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def move_to_trash(path: Path) -> None:
    if "\n" in str(path) or "\x00" in str(path):
        raise ValueError("Неподдерживаемый путь")
    script = f'tell application "Finder" to delete POSIX file {applescript_string(str(path))}\n'
    result = subprocess.run(
        ["osascript", "-"],
        input=script,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Finder отказал").strip()
        raise RuntimeError(detail)


def parse_du_line(line: str) -> tuple[int, str]:
    if "\t" in line:
        size_s, raw_path = line.split("\t", 1)
    else:
        size_s, raw_path = line.split(None, 1)
    return int(size_s) * 1024, os.path.normpath(raw_path)


def _describe_entry(entry: os.DirEntry[str]) -> dict:
    is_dir = entry.is_dir(follow_symlinks=False)
    if not is_dir and entry.is_symlink() and entry.is_dir(follow_symlinks=True):
        try:
            is_dir = inside_home(Path(os.path.realpath(entry.path)))
        except OSError:
            is_dir = False
    try:
        stat = entry.stat(follow_symlinks=False)
        readable = os.access(entry.path, os.R_OK | (os.X_OK if is_dir else 0))
    except OSError:
        stat = None
        readable = False
    size = None
    pending = False
    if stat is not None and not is_dir:
        size = stat.st_blocks * 512
    elif is_dir and readable:
        pending = True
    return {
        "name": entry.name,
        "path": entry.path,
        "dir": is_dir,
        "size": size,
        "modified": int(stat.st_mtime) if stat is not None else None,
        "accessible": readable,
        "pending": pending,
    }


def directory_size(folder: str, token: int) -> int | None:
    proc = subprocess.Popen(
        ["du", "-k", "-d", "0", folder],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    if not SCANS.bind(token, proc):
        return None
    stdout, _stderr = proc.communicate()
    SCANS.release(proc)
    if not SCANS.current(token) or proc.returncode not in (0, 1):
        return None
    lines = stdout.strip().splitlines()
    if not lines:
        return None
    try:
        size, _raw_path = parse_du_line(lines[0])
    except ValueError:
        return None
    return size


def iter_directory(path: Path, token: int):
    if not path.exists():
        raise FileNotFoundError(str(path))
    if not path.is_dir():
        raise NotADirectoryError(str(path))
    mtime = path.stat().st_mtime_ns
    key = str(path)
    parent = str(path.parent) if path != HOME and inside_home(path.parent) else None
    yield {"kind": "start", "path": str(path), "home": str(HOME), "parent": parent}

    with CACHE_LOCK:
        cached = CACHE.get(key)
    if cached and cached[0] == mtime and SCANS.current(token):
        for entry in cached[1]["entries"]:
            yield {"kind": "entry", **entry}
        yield {"done": True, "cancelled": False, "total": cached[1]["total"], "cached": True}
        return

    entries: list[dict] = []
    with os.scandir(path) as scan:
        for dir_entry in scan:
            if not SCANS.current(token):
                yield {"done": True, "cancelled": True}
                return
            item = _describe_entry(dir_entry)
            entries.append(item)
            yield {"kind": "entry", **item}

    pending = [item["path"] for item in entries if item["pending"]]
    executor = ThreadPoolExecutor(max_workers=4)
    try:
        futures = {executor.submit(directory_size, folder, token): folder for folder in pending}
        for future in as_completed(futures):
            if not SCANS.current(token):
                yield {"done": True, "cancelled": True}
                return
            folder = futures[future]
            size = future.result()
            for item in entries:
                if item["path"] != folder:
                    continue
                item["size"] = size
                item["pending"] = False
                if size is None:
                    item["accessible"] = False
                break
            yield {
                "kind": "size",
                "path": folder,
                "size": size,
                "accessible": size is not None,
            }
    finally:
        executor.shutdown(wait=True, cancel_futures=True)

    if not SCANS.current(token):
        yield {"done": True, "cancelled": True}
        return
    total = sum(item["size"] or 0 for item in entries)
    try:
        mtime_after = path.stat().st_mtime_ns
    except OSError:
        mtime_after = None
    if mtime_after == mtime and SCANS.current(token):
        with CACHE_LOCK:
            CACHE[key] = (
                mtime,
                {
                    "path": str(path),
                    "home": str(HOME),
                    "parent": parent,
                    "total": total,
                    "entries": entries,
                },
            )
    yield {"done": True, "cancelled": False, "total": total, "cached": False}


def iter_large_files(path: Path, min_bytes: int, token: int):
    root_dev = path.stat().st_dev
    stack = [path]
    while stack:
        if not SCANS.current(token):
            yield {"done": True, "cancelled": True}
            return
        current = stack.pop()
        try:
            scan = os.scandir(current)
        except OSError:
            continue
        with scan:
            for entry in scan:
                if not SCANS.current(token):
                    yield {"done": True, "cancelled": True}
                    return
                try:
                    if entry.is_symlink():
                        continue
                    stat = entry.stat(follow_symlinks=False)
                    if stat.st_dev != root_dev:
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(Path(entry.path))
                        continue
                    if not entry.is_file(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                allocated = stat.st_blocks * 512
                if allocated < min_bytes:
                    continue
                yield {
                    "name": entry.name,
                    "path": entry.path,
                    "dir": False,
                    "size": allocated,
                    "modified": int(stat.st_mtime),
                    "accessible": True,
                }
    yield {"done": True, "cancelled": not SCANS.current(token)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "disk-radar"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("disk-radar " + (fmt % args) + "\n")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_error(403)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if parsed.path == "/api/list":
            self._list(parse_qs(parsed.query))
            return
        if parsed.path == "/api/large-files":
            self._large(parse_qs(parsed.query))
            return
        self._static(parsed.path)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/trash":
            self.send_error(404)
            return
        self._trash()

    def _authorized(self) -> bool:
        given = self.headers.get("X-Disk-Radar-Token", "")
        return secrets.compare_digest(given, TOKEN)

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _list(self, query: dict[str, list[str]]) -> None:
        if not self._authorized():
            self._send_json(403, {"error": "Нужен токен страницы"})
            return
        raw = query.get("path", [None])[0]
        if raw:
            raw = unquote(raw)
        try:
            path = resolved_home_path(raw) if raw else HOME
            if not path.exists():
                raise FileNotFoundError(str(path))
            if not path.is_dir():
                raise NotADirectoryError(str(path))
        except PermissionError as exc:
            self._send_json(403, {"error": str(exc)})
            return
        except FileNotFoundError:
            self._send_json(404, {"error": "Папка не найдена"})
            return
        except NotADirectoryError:
            self._send_json(400, {"error": "Это не папка"})
            return
        except OSError as exc:
            self._send_json(403, {"error": exc.strerror or "Нет доступа"})
            return
        token = SCANS.start()
        self._stream(iter_directory(path, token))

    def _large(self, query: dict[str, list[str]]) -> None:
        if not self._authorized():
            self._send_json(403, {"error": "Нужен токен страницы"})
            return
        raw = unquote(query.get("path", [str(HOME)])[0])
        try:
            min_bytes = int(query.get("min_bytes", [str(1024 ** 3)])[0])
        except ValueError:
            self._send_json(400, {"error": "Некорректный порог"})
            return
        if min_bytes < 0 or min_bytes > 100 * 1024**4:
            self._send_json(400, {"error": "Некорректный порог"})
            return
        try:
            path = resolved_home_path(raw)
            if not path.is_dir():
                raise NotADirectoryError(path)
        except PermissionError as exc:
            self._send_json(403, {"error": str(exc)})
            return
        except FileNotFoundError:
            self._send_json(404, {"error": "Папка не найдена"})
            return
        except NotADirectoryError:
            self._send_json(400, {"error": "Это не папка"})
            return
        token = SCANS.start()
        self._stream(iter_large_files(path, min_bytes, token))

    def _stream(self, items) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            for item in items:
                line = json.dumps(item, ensure_ascii=False).encode() + b"\n"
                self.wfile.write(f"{len(line):X}\r\n".encode() + line + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            return

    def _trash(self) -> None:
        if not self._authorized():
            self._send_json(403, {"error": "Нужен токен страницы"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Некорректный запрос"})
            return
        if length <= 0 or length > 1_000_000:
            self._send_json(400, {"error": "Некорректный запрос"})
            return
        try:
            body = json.loads(self.rfile.read(length))
            paths = body["paths"]
        except (json.JSONDecodeError, KeyError, TypeError):
            self._send_json(400, {"error": "Некорректный запрос"})
            return
        if not isinstance(paths, list) or not paths or len(paths) > MAX_TRASH:
            self._send_json(400, {"error": "Слишком много объектов"})
            return
        ok = []
        failed = []
        for raw in paths:
            if not isinstance(raw, str):
                failed.append({"path": str(raw), "error": "Некорректный путь"})
                continue
            try:
                path = lexical_home_path(raw)
                reason = trash_block_reason(path)
                if reason:
                    raise PermissionError(reason)
                if not path.exists() and not path.is_symlink():
                    raise FileNotFoundError(str(path))
                move_to_trash(path)
            except (PermissionError, ValueError, FileNotFoundError, RuntimeError, subprocess.TimeoutExpired) as exc:
                failed.append({"path": raw, "error": str(exc) or "Не удалось убрать в Корзину"})
            else:
                ok.append({"path": raw})
        code = 200 if ok or not failed else 403
        self._send_json(code, {"ok": ok, "failed": failed})

    def _static(self, request_path: str) -> None:
        name = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
        if name not in {"index.html", "app.js", "style.css"}:
            self.send_error(404)
            return
        file_path = APP_ROOT / "static" / name
        data = file_path.read_bytes()
        if name == "index.html":
            data = data.replace(b"__TOKEN__", TOKEN.encode())
        content_type = {
            "index.html": "text/html; charset=utf-8",
            "app.js": "text/javascript; charset=utf-8",
            "style.css": "text/css; charset=utf-8",
        }[name]
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    print(f"disk-radar {url}", flush=True)
    if os.environ.get("DISK_RADAR_NO_BROWSER") != "1":
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
