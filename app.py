"""Offline browser editor. Run with Python; no third-party dependencies."""
import argparse
from contextlib import contextmanager
import io
import json
import os
import queue
import re
import secrets
import shutil
import sys
import tempfile
import threading
import time
import tokenize
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

from session import ROOT, Session, probe_interpreter
from execution import statement_at


@contextmanager
def instance_lock(path):
    """An OS-owned lock is released even if the editor crashes."""
    with Path(path).open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
        else:
            yield True


def existing_instance_url():
    # Another launch may still be starting its interpreter and HTTP server.
    for _ in range(100):
        try:
            running = json.loads((ROOT / ".running.json").read_text(encoding="utf-8"))
            url = running["url"]
            parsed = urlsplit(url)
            token = parse_qs(parsed.fragment)["token"][0]
            if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port:
                return None
            request = Request(f"http://127.0.0.1:{parsed.port}/api/state", headers={"X-Editor-Token": token})
            with urlopen(request, timeout=1) as response:
                if "session" in json.load(response):
                    return url
        except (OSError, ValueError, KeyError, TypeError):
            pass
        time.sleep(.1)
    return None


def open_browser(url):
    chrome = find_chrome()
    if not (chrome and webbrowser.BackgroundBrowser(chrome).open(url)):
        webbrowser.open(url)


def find_chrome():
    candidates = [
        Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local"))) / "Google/Chrome/Application/chrome.exe",
    ]
    for name in ("chrome", "google-chrome", "google-chrome-stable"):
        executable = shutil.which(name)
        if executable:
            candidates.append(Path(executable))
    return next((str(candidate) for candidate in candidates if candidate.is_file()), None)


def python_filename(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("请输入文件名")
    name = value.strip()
    if len(name) > 200 or re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or name.endswith("."):
        raise ValueError("文件名不能包含路径、特殊字符或以句点结尾")
    if Path(name).suffix == "":
        name += ".py"
    if not name.lower().endswith(".py"):
        raise ValueError("请使用 .py 文件扩展名")
    reserved = {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}
    if name.split(".")[0].upper() in reserved or name.startswith("."):
        raise ValueError("此文件名不可用，请换一个名字")
    return name


def read_document(path):
    path = Path(path).resolve()
    raw = path.read_bytes()
    if len(raw) > 1024 * 1024:
        raise ValueError("第一版支持不超过 1 MB 的代码文件")
    encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
    text = raw.decode(encoding)
    newline = "\r\n" if b"\r\n" in raw else "\n"
    return {"path": str(path), "text": text.replace("\r\n", "\n").replace("\r", "\n"), "encoding": encoding, "newline": newline}


def save_document(path, text, encoding="utf-8", newline="\n"):
    path = Path(path).resolve()
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    data = normalized.replace("\n", newline).encode(encoding)
    if len(data) > 1024 * 1024:
        raise ValueError("第一版支持不超过 1 MB 的代码文件")
    # Honor a coding cookie edited by the user; never create a self-contradictory file.
    declared, _ = tokenize.detect_encoding(io.BytesIO(data).readline)
    if data.decode(declared) != normalized.replace("\n", newline):
        raise ValueError("文件编码声明与当前编码不一致，请检查 coding 声明")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".editor-", suffix=".tmp", delete=False) as stream:
            temporary = stream.name
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


class Dialogs:
    """Network threads queue dialogs; Tk only runs on the application's main thread."""
    def __init__(self):
        import tkinter as tk
        self.root = tk.Tk()
        self.root.withdraw()
        self.pending = queue.Queue()
        self.closed = False
        self.root.after(50, self.drain)

    def ask(self, kind, current=None):
        result, done = {}, threading.Event()
        self.pending.put((kind, current, result, done))
        done.wait()
        if "error" in result:
            raise ValueError(result["error"])
        return result.get("path", "")

    def drain(self):
        from tkinter import filedialog
        if self.closed:
            self.root.quit()
            return
        try:
            kind, current, result, done = self.pending.get_nowait()
        except queue.Empty:
            self.root.after(50, self.drain)
            return
        try:
            self.root.attributes("-topmost", True)
            initial = Path(current) if current else ROOT
            options = {"parent": self.root, "initialdir": str(initial if initial.is_dir() else initial.parent)}
            if kind == "folder":
                result["path"] = filedialog.askdirectory(title="选择工作文件夹", mustexist=True, **options)
            elif kind == "interpreter":
                result["path"] = filedialog.askopenfilename(title="选择本地 Python 解释器（python.exe）", filetypes=[("Python 解释器", "*.exe"), ("所有文件", "*.*")], **options)
            elif kind == "open":
                result["path"] = filedialog.askopenfilename(title="打开 Python 文件", filetypes=[("Python 文件", "*.py"), ("所有文件", "*.*")], **options)
            else:
                result["path"] = filedialog.asksaveasfilename(title="保存 Python 文件", initialfile=Path(current).name if current else "未命名.py", defaultextension=".py", filetypes=[("Python 文件", "*.py")], **options)
        except Exception as exc:
            result["error"] = str(exc)
        finally:
            self.root.attributes("-topmost", False)
            done.set()
            self.root.after(50, self.drain)


class Application:
    def __init__(self, data_dir=ROOT, chooser=None):
        self.data_dir = Path(data_dir)
        self.chooser = chooser
        self.token = secrets.token_urlsafe(32)
        self.style_nonce = secrets.token_urlsafe(16)
        self.closed = False
        self.clients = {}
        self.client_lock = threading.Lock()
        self.last_client_left = None
        self.file_lock = threading.Lock()
        self.path = None
        self.folder = None
        self.document_id = secrets.token_hex(16)
        self.encoding = "utf-8"
        self.newline = "\n"
        default = probe_interpreter(sys.executable)
        self.interpreters = [default]
        selected = default["path"]
        warning = ""
        try:
            settings = json.loads((self.data_dir / "settings.json").read_text(encoding="utf-8"))
            for item in settings.get("interpreters", []):
                if isinstance(item, dict) and isinstance(item.get("path"), str) and item["path"] != default["path"]:
                    self.interpreters.append(item)
            selected = settings.get("selected", selected)
            if selected not in [item["path"] for item in self.interpreters]:
                selected = default["path"]
            if selected != default["path"]:
                probe_interpreter(selected)
        except FileNotFoundError:
            pass
        except (ValueError, OSError, TypeError):
            selected = default["path"]
            warning = "保存的解释器不可用或配置损坏，已使用启动环境。\n"
        self.selected = selected
        self.session = Session(selected, ROOT)
        if warning:
            self.session.emit("notice", text=warning)

    def state(self):
        return {"session": self.session.snapshot(), "path": self.path, "folder": self.folder, "encoding": self.encoding, "document_id": self.document_id,
                "interpreters": self.interpreters, "selected": self.selected}

    def save_settings(self):
        data = json.dumps({"interpreters": self.interpreters, "selected": self.selected}, ensure_ascii=False, indent=2)
        save_document(self.data_dir / "settings.json", data)

    def choose(self, kind):
        if self.chooser is None:
            raise ValueError("当前启动方式未启用本地文件选择框")
        initial = self.path or (str(Path(self.folder) / "未命名.py") if self.folder else None)
        if kind == "folder":
            initial = self.folder or (str(Path(self.path).parent) if self.path else str(ROOT))
        return self.chooser(kind, initial)

    def action(self, route, data):
        session = self.session
        if route == "/api/client":
            client_id, active, revision = data.get("id"), data.get("active"), data.get("revision")
            if (not isinstance(client_id, str) or not 0 < len(client_id) <= 128
                    or not isinstance(active, bool) or type(revision) is not int or revision < 1):
                raise ValueError("无效的页面状态")
            with self.client_lock:
                previous = self.clients.get(client_id)
                if previous is None or revision > previous[0]:
                    self.clients[client_id] = (revision, active)
                    self.last_client_left = None if any(value[1] for value in self.clients.values()) else time.monotonic()
            return {"ok": True}
        elif route == "/api/statement":
            return statement_at(data.get("source"), data.get("line"))
        elif route == "/api/execute":
            session.execute(data.get("source"), data.get("mode", "line"), data.get("run_id"), data.get("start_line", 1), data.get("expected_generation"))
        elif route == "/api/input":
            session.submit_input(data.get("text"))
        elif route in ("/api/reset", "/api/stop"):
            session.reset()
        elif route == "/api/cancel-buffer":
            session.cancel_buffer()
        elif route == "/api/clear":
            session.clear()
            return {**self.state(), "cursor": session.sequence}
        elif route == "/api/folder/select":
            with self.file_lock:
                path = self.choose("folder")
                if not path:
                    return {"cancelled": True}
                folder = Path(path).resolve()
                if not folder.is_dir():
                    raise ValueError("请选择存在的文件夹")
                self.folder = str(folder)
                return self.state()
        elif route.startswith("/api/file/"):
            with self.file_lock:
                return self.file_action(route, data)
        elif route == "/api/interpreters/discover":
            from interpreters import discover_interpreters
            project = Path(self.path).parent if self.path else Path(self.folder) if self.folder else ROOT
            return {"interpreters": discover_interpreters(project)}
        elif route == "/api/interpreters/add":
            path = data.get("path") or self.choose("interpreter")
            if not isinstance(path, str):
                raise ValueError("无效的解释器路径")
            if not path:
                return {"cancelled": True}
            entry = probe_interpreter(path)
            if entry["path"] not in [item["path"] for item in self.interpreters]:
                self.interpreters.append(entry)
            self.save_settings()
            return {**self.state(), "added": entry["path"]}
        elif route == "/api/interpreters/select":
            path = data.get("path")
            if path not in [item["path"] for item in self.interpreters]:
                raise ValueError("请先添加该解释器")
            entry = probe_interpreter(path)
            previous = self.selected
            try:
                session.reset(executable=entry["path"])
            except ValueError:
                session.reset(executable=previous)
                raise
            self.selected = entry["path"]
            self.save_settings()
        elif route == "/api/interpreters/remove":
            path = data.get("path")
            if path == self.selected:
                raise ValueError("请先切换到另一个解释器，再移除此项")
            self.interpreters = [item for item in self.interpreters if item["path"] != path]
            self.save_settings()
        elif route == "/api/shutdown":
            self.closed = True
        else:
            raise ValueError("未知操作")
        return self.state()

    def file_action(self, route, data):
        if route == "/api/file/new":
            if not self.folder or not Path(self.folder).is_dir():
                raise ValueError("请先选择一个存在的工作文件夹，再新建文件")
            path = Path(self.folder) / python_filename(data.get("name"))
            with path.open("x", encoding="utf-8"):
                pass
            try:
                self.session.reset(cwd=self.folder, filename=path)
            except Exception:
                if path.read_bytes() == b"":
                    path.unlink()
                raise
            self.path, self.encoding, self.newline = str(path), "utf-8", "\n"
            self.document_id = secrets.token_hex(16)
            return {**self.state(), "text": ""}
        if route == "/api/file/open":
            path = self.choose("open")
            if not path:
                return {"cancelled": True}
            document = read_document(path)
            self.session.reset(cwd=Path(path).parent, filename=path)
            self.path, self.encoding, self.newline = document["path"], document["encoding"], document["newline"]
            self.document_id = secrets.token_hex(16)
            return {**self.state(), "text": document["text"]}
        if route != "/api/file/save":
            if route != "/api/file/rename":
                raise ValueError("未知文件操作")
            if data.get("document_id") != self.document_id or not self.path:
                raise ValueError("当前文件已改变，请重新打开目标文件后重命名")
            old_path = Path(self.path)
            target = old_path.with_name(python_filename(data.get("name")))
            if str(target) == str(old_path):
                return self.state()
            case_only = os.name == "nt" and target.name.casefold() == old_path.name.casefold()
            if target.exists() and not case_only:
                raise ValueError("同名文件已存在，请换一个名字")
            if self.session.snapshot()["status"] not in ("idle", "more", "exited"):
                raise ValueError("请等程序运行结束或停止后，再重命名文件")
            old_path.rename(target)
            self.path = str(target)
            self.document_id = secrets.token_hex(16)
            self.session.set_filename(target)
            return self.state()
        text = data.get("text")
        if data.get("document_id") != self.document_id:
            raise ValueError("文件已在其他页面切换，请重新打开目标文件后再保存。当前代码仍保留在页面中。")
        if not isinstance(text, str):
            raise ValueError("缺少文件内容")
        path = self.path
        if not path and (not self.folder or not Path(self.folder).is_dir()):
            raise ValueError("请先选择工作文件夹，再保存新文件")
        if not path or data.get("save_as"):
            path = self.choose("save")
            if not path:
                return {"cancelled": True}
        save_document(path, text, self.encoding, self.newline)
        self.path = str(Path(path).resolve())
        return self.state()

    def close(self):
        self.closed = True
        self.session.close()

    def check_shutdown(self):
        with self.client_lock:
            # Refresh and back/forward navigation can reconnect during this grace period.
            if self.last_client_left is not None and time.monotonic() - self.last_client_left >= 3:
                self.closed = True
        return self.closed


def make_server(application):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, data, mime="application/json; charset=utf-8"):
            raw = json.dumps(data, ensure_ascii=False).encode("utf-8") if mime.startswith("application/json") else data
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", f"default-src 'self'; script-src 'self'; style-src 'self' 'nonce-{application.style_nonce}'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def authorized(self, api=False, mutation=False):
            expected = f"127.0.0.1:{self.server.server_port}"
            if self.headers.get("Host") != expected:
                return False
            origin = self.headers.get("Origin")
            if origin and origin != f"http://{expected}":
                return False
            if mutation and origin != f"http://{expected}":
                return False
            return not api or secrets.compare_digest(self.headers.get("X-Editor-Token", ""), application.token)

        def do_GET(self):
            parsed = urlsplit(self.path)
            api = parsed.path.startswith("/api/")
            if not self.authorized(api):
                self.reply(403, {"error": "请求被拒绝，请使用启动时打开的页面"})
                return
            if parsed.path == "/api/state":
                self.reply(200, application.state())
            elif parsed.path == "/api/events":
                try:
                    after = int(parse_qs(parsed.query).get("after", ["0"])[0])
                    self.reply(200, {**application.session.events(after), "document_id": application.document_id, "folder": application.folder})
                except ValueError:
                    self.reply(400, {"error": "无效的事件游标"})
            elif parsed.path in ("/", "/style.css", "/app.js", "/favicon.svg", "/vendor/code-editor.js"):
                filename = {"/": "index.html"}.get(parsed.path, parsed.path[1:])
                mime = {"index.html": "text/html; charset=utf-8", "style.css": "text/css; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "vendor/code-editor.js": "text/javascript; charset=utf-8", "favicon.svg": "image/svg+xml"}[filename]
                content = (ROOT / "web" / filename).read_bytes()
                if filename == "index.html":
                    content = content.replace(b"__EDITOR_STYLE_NONCE__", application.style_nonce.encode("ascii"))
                self.reply(200, content, mime)
            else:
                self.reply(404, {"error": "未找到页面"})

        def do_POST(self):
            if not self.authorized(api=True, mutation=True):
                self.reply(403, {"error": "请求被拒绝，请使用启动时打开的页面"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8 * 1024 * 1024:
                    raise ValueError("请求大小无效或超过限制")
                data = json.loads(self.rfile.read(size).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("请求必须是对象")
                self.reply(200, application.action(urlsplit(self.path).path, data))
            except (OSError, ValueError, SyntaxError, UnicodeError) as exc:
                self.reply(400, {"error": str(exc)})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description="轻量 Python 编辑器")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--no-dialogs", action="store_true", help="供自动化测试使用")
    args = parser.parse_args()
    with instance_lock(ROOT / ".instance.lock") as owner:
        if not owner:
            url = existing_instance_url()
            if not url:
                raise SystemExit("已有编辑器正在启动或退出，请稍后重试。")
            if not args.no_browser:
                open_browser(url)
            return
        run_application(args)


def run_application(args):
    dialogs = None if args.no_dialogs else Dialogs()
    application = Application(chooser=dialogs.ask if dialogs else None)
    server = make_server(application)
    url = f"http://127.0.0.1:{server.server_port}/#token={application.token}"
    print(f"\n轻量 Python 编辑器\n{url}\n\n关闭最后一个编辑页面后自动退出，也可使用页面右上角按钮或 Ctrl+C。", flush=True)
    (ROOT / ".running.json").write_text(json.dumps({"url": url, "pid": os.getpid()}), encoding="utf-8")
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def watch_shutdown():
        if application.check_shutdown():
            dialogs.closed = True
        else:
            dialogs.root.after(100, watch_shutdown)

    try:
        if not args.no_browser:
            open_browser(url)
        if dialogs:
            dialogs.root.after(100, watch_shutdown)
            dialogs.root.mainloop()
        else:
            while not application.check_shutdown():
                threading.Event().wait(.1)
    except KeyboardInterrupt:
        pass
    finally:
        application.close()
        server.shutdown()
        server.server_close()
        if dialogs:
            dialogs.root.destroy()
        try:
            running = ROOT / ".running.json"
            if json.loads(running.read_text(encoding="utf-8")).get("pid") == os.getpid():
                running.unlink()
        except (FileNotFoundError, ValueError):
            pass


if __name__ == "__main__":
    main()
