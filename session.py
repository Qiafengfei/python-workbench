"""One persistent interpreter, bounded event history, and process lifecycle."""
import codecs
import json
import os
import secrets
import subprocess
import sys
import threading
from collections import deque
from multiprocessing.connection import Listener
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def probe_interpreter(path):
    path = str(Path(path).resolve())
    if not Path(path).is_file():
        raise ValueError("解释器文件不存在")
    try:
        result = subprocess.run(
            [path, "-I", "-c", "import sys,json; print(json.dumps([sys.executable,list(sys.version_info[:3])]))"],
            capture_output=True, text=True, encoding="utf-8", timeout=5, creationflags=NO_WINDOW,
        )
        executable, version = json.loads(result.stdout)
        if result.returncode or os.path.normcase(os.path.realpath(executable)) != os.path.normcase(os.path.realpath(path)):
            raise ValueError("请选择实际的 Python 解释器，不要选择启动器")
        if tuple(version) < (3, 10):
            raise ValueError("需要 Python 3.10 或更新版本")
        return {"path": path, "label": "Python " + ".".join(map(str, version)), "version": version}
    except (OSError, subprocess.SubprocessError, ValueError, TypeError) as exc:
        raise ValueError(f"无法使用此 Python 解释器：{exc}") from exc


class Session:
    MAX_EVENT_BYTES = 1024 * 1024

    def __init__(self, executable, cwd=ROOT, filename=None):
        self.executable = str(executable)
        self.cwd = str(cwd)
        self.filename = str(filename) if filename else None
        self.lock = threading.RLock()
        self.operation = threading.RLock()
        self.history = deque()
        self.event_bytes = 0
        self.sequence = 0
        self.generation = 0
        self.process = None
        self.connection = None
        self.job = None
        self.readers = []
        self.status = "exited"
        self.run_id = None
        self.mode = None
        self.last_result = None
        self.reset()

    def emit(self, kind, **data):
        with self.lock:
            self.sequence += 1
            event = {"id": self.sequence, "type": kind, "run_id": self.run_id, "mode": self.mode, "generation": self.generation, **data}
            size = len(json.dumps(event, ensure_ascii=False).encode("utf-8"))
            self.history.append((event, size))
            self.event_bytes += size
            while self.history and (self.event_bytes > self.MAX_EVENT_BYTES or len(self.history) > 2000):
                _, removed = self.history.popleft()
                self.event_bytes -= removed

    def snapshot(self):
        with self.lock:
            return {"status": self.status, "generation": self.generation, "pid": self.process.pid if self.process else None, "run_id": self.run_id, "mode": self.mode, "last_result": self.last_result}

    def events(self, after=0):
        with self.lock:
            return {
                "events": [event for event, _ in self.history if event["id"] > after],
                "cursor": self.sequence,
                "truncated": bool(self.history and after and after < self.history[0][0]["id"] - 1),
                "state": self.snapshot(),
            }

    def _read_output(self, pipe, kind, generation):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        try:
            while True:
                data = os.read(pipe.fileno(), 4096)
                if not data:
                    break
                with self.lock:
                    if generation != self.generation:
                        return
                    self.emit(kind, text=decoder.decode(data))
            tail = decoder.decode(b"", final=True)
            if tail and generation == self.generation:
                self.emit(kind, text=tail)
        except (OSError, ValueError):
            pass
        finally:
            pipe.close()

    def _read_control(self, connection, generation):
        try:
            while True:
                event = json.loads(connection.recv_bytes().decode("utf-8"))
                with self.lock:
                    if generation != self.generation:
                        return
                    kind = event["type"]
                    if kind in ("stdout", "stderr"):
                        self.emit(kind, text=event["text"], run_id=event.get("run_id"), mode=event.get("mode"))
                        continue
                    if kind == "done":
                        self.status = "more" if event.get("more") else "idle"
                        self.last_result = {"run_id": event.get("run_id"), "success": event.get("success", False), "generation": generation}
                    elif kind in ("input", "running"):
                        self.status = kind
                    elif kind == "exit":
                        self.status = "exited"
                        self.last_result = {"run_id": event.get("run_id"), "success": False, "generation": generation}
                    self.emit("state", **self.snapshot())
        except (OSError, EOFError, ValueError):
            pass
        finally:
            with self.lock:
                if generation == self.generation:
                    self.status = "exited"
                    self.emit("state", **self.snapshot())

    def _kill(self):
        process = self.process
        if self.job:
            self.job.close()
            self.job = None
        if process:
            # Kill the tree even if the worker exited but left child processes alive.
            if os.name != "nt":
                import signal
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            if process.stdin:
                process.stdin.close()
        if self.connection:
            self.connection.close()
        self.connection = None
        self.process = None
        for thread in self.readers:
            thread.join(timeout=2)
        self.readers.clear()

    def reset(self, executable=None, cwd=None, filename=None):
        with self.operation:
            with self.lock:
                self.generation += 1
                generation = self.generation
                self.status = "starting"
                self.last_result = None
            self._kill()
            if executable is not None:
                self.executable = str(executable)
            if cwd is not None:
                self.cwd = str(cwd)
                self.filename = str(filename) if filename else None
            key = secrets.token_bytes(32)
            listener = Listener(("127.0.0.1", 0), authkey=key)
            # Listener exposes no public accept timeout; bound interpreter startup.
            listener._listener._socket.settimeout(6)
            env = {**os.environ, "EDITOR_WORKER_KEY": key.hex(), "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
            try:
                self.process = subprocess.Popen(
                    [self.executable, "-u", str(ROOT / "worker.py"), str(listener.address[1]), self.filename or ""],
                    cwd=self.cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    creationflags=NO_WINDOW, start_new_session=os.name != "nt",
                )
                if os.name == "nt":
                    from windows_job import WindowsJob
                    self.job = WindowsJob(self.process)
                self.connection = listener.accept()
                if not self.connection.poll(5):
                    raise ValueError("解释器启动超时")
                ready = json.loads(self.connection.recv_bytes().decode("utf-8"))
                if ready.get("type") != "ready":
                    raise ValueError("解释器未就绪")
                with self.lock:
                    self.status = "idle"
                    self.emit("notice", text="会话已重置，之前的变量已清除。\n")
                    self.emit("state", **self.snapshot())
                for pipe, kind in ((self.process.stdout, "stdout"), (self.process.stderr, "stderr")):
                    reader = threading.Thread(target=self._read_output, args=(pipe, kind, generation), daemon=True)
                    self.readers.append(reader)
                    reader.start()
                reader = threading.Thread(target=self._read_control, args=(self.connection, generation), daemon=True)
                self.readers.append(reader)
                reader.start()
            except Exception as exc:
                self._kill()
                with self.lock:
                    self.status = "exited"
                raise ValueError(f"无法启动解释器：{exc}") from exc
            finally:
                listener.close()

    def execute(self, source, mode="line", run_id=None, start_line=1, expected_generation=None):
        if mode not in ("line", "selection", "all", "incremental") or not isinstance(source, str):
            raise ValueError("无效的执行请求")
        if type(start_line) is not int or not 1 <= start_line <= 1048577:
            raise ValueError("无效的执行起始行")
        if len(source.encode("utf-8")) > 1024 * 1024:
            raise ValueError("单次代码不能超过 1 MB")
        if run_id is not None and (not isinstance(run_id, str) or not 1 <= len(run_id) <= 100 or not all(c.isalnum() or c in "-_" for c in run_id)):
            raise ValueError("无效的执行标识")
        with self.operation, self.lock:
            if expected_generation is not None and (type(expected_generation) is not int or expected_generation != self.generation):
                raise ValueError("会话已重置，旧的执行请求已取消")
            if self.status not in ("idle", "more"):
                raise ValueError("解释器正在运行或尚未就绪")
            if self.status == "more" and mode != "line":
                raise ValueError("请先结束或取消待续代码，再运行选区或全部代码")
            if mode == "all":
                self.clear()
            self.run_id = run_id or secrets.token_hex(12)
            self.mode = mode
            self.last_result = None
            self.status = "running"
            self.emit("code", text=source + "\n", mode=mode)
            try:
                self.connection.send_bytes(json.dumps({"action": "execute", "source": source, "mode": mode, "run_id": self.run_id, "start_line": start_line}).encode("utf-8"))
            except (OSError, EOFError) as exc:
                self.status = "exited"
                raise ValueError("解释器已退出，请重置会话") from exc

    def cancel_buffer(self):
        with self.operation, self.lock:
            if self.status != "more":
                raise ValueError("当前没有待续代码")
            self.status = "running"
            self.connection.send_bytes(b'{"action":"cancel"}')

    def set_filename(self, filename):
        with self.operation, self.lock:
            self.filename = str(filename)
            if self.status != "exited":
                self.connection.send_bytes(json.dumps({"action": "filename", "filename": self.filename}).encode("utf-8"))

    def submit_input(self, text):
        with self.operation, self.lock:
            if self.status != "input":
                raise ValueError("程序当前没有等待输入")
            if not isinstance(text, str) or "\n" in text or "\r" in text or len(text.encode("utf-8")) > 8192:
                raise ValueError("请输入不超过 8 KB 的单行文本")
            self.process.stdin.write((text + "\n").encode("utf-8"))
            self.process.stdin.flush()
            self.status = "running"
            self.emit("stdin", text=text + "\n")

    def clear(self):
        with self.lock:
            self.history.clear()
            self.event_bytes = 0

    def close(self):
        with self.operation:
            with self.lock:
                self.generation += 1
                self.status = "exited"
            self._kill()
