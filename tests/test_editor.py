import sys
import tempfile
import time
import unittest
import json
import threading
import urllib.request
import urllib.error
import contextlib
import shutil
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


@contextlib.contextmanager
def scratch_directory():
    # Python 3.13's Windows mode=0o700 temp directories conflict with managed ACLs.
    folder = ROOT / "tests" / ("scratch-" + uuid.uuid4().hex)
    folder.mkdir()
    try:
        yield str(folder)
    finally:
        assert folder.resolve().parent == (ROOT / "tests").resolve()
        shutil.rmtree(folder)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        from session import Session
        self.session = Session(sys.executable, ROOT)

    def tearDown(self):
        self.session.close()

    def wait(self, predicate, timeout=6):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            events = self.session.events(0)["events"]
            if predicate(events):
                return events
            time.sleep(.02)
        self.fail(f"Timed out: {self.session.snapshot()} {events[-10:]}")

    def run_code(self, source, mode="line"):
        self.session.execute(source, mode)
        self.wait(lambda _: self.session.snapshot()["status"] in ("idle", "more", "exited"))

    def output(self):
        return "".join(e.get("text", "") for e in self.session.events(0)["events"] if e["type"] in ("stdout", "stderr"))

    def test_variables_expression_and_recovery(self):
        self.run_code("x = 1")
        self.run_code("x + 1")
        self.wait(lambda _: "2" in self.output())
        self.run_code("1 / 0")
        self.wait(lambda _: "ZeroDivisionError" in self.output())
        self.run_code("print('中文', x)")
        self.wait(lambda _: "中文 1" in self.output())

    def test_incremental_status_last_expression_and_real_line_number(self):
        self.run_code("import math\nx = math.sqrt(4)", "incremental")
        self.assertTrue(self.session.snapshot()["last_result"]["success"])
        self.run_code("x += 1\nx", "incremental")
        self.wait(lambda _: "3.0" in self.output())
        self.session.execute("missing_name", "incremental", start_line=18)
        self.wait(lambda _: self.session.snapshot()["status"] == "idle")
        self.assertFalse(self.session.snapshot()["last_result"]["success"])
        self.assertIn("line 18", self.output())
        self.run_code("print(x)", "incremental")
        self.assertTrue(self.session.snapshot()["last_result"]["success"])

    def test_incremental_future_flags(self):
        self.run_code("from __future__ import annotations", "incremental")
        self.run_code("def f(value: UndefinedType):\n    return value\nf", "incremental")
        self.assertTrue(self.session.snapshot()["last_result"]["success"], self.output())
        self.assertNotIn("NameError", self.output())

    def test_stale_generation_request_is_rejected_after_stop(self):
        old = self.session.generation
        self.session.reset()
        with self.assertRaises(ValueError):
            self.session.execute("print('must-not-run')", "incremental", expected_generation=old)
        self.assertEqual(self.session.snapshot()["status"], "idle")

    def test_multiline_and_cancel(self):
        self.run_code("for i in range(2):")
        self.assertEqual(self.session.snapshot()["status"], "more")
        self.run_code("    print(i)")
        self.run_code("")
        self.wait(lambda _: "0\n1\n" in self.output())
        self.run_code("if True:")
        with self.assertRaises(ValueError):
            self.session.execute("print(3)", "selection")
        self.session.cancel_buffer()
        self.wait(lambda _: self.session.snapshot()["status"] == "idle")
        self.run_code("i")
        self.wait(lambda _: self.output().endswith("1\n"))

    def test_selection_file_and_input(self):
        self.run_code("a = 4\nb = 5", "selection")
        self.run_code("a + b", "selection")
        self.wait(lambda _: "9\n" in self.output())
        self.session.execute("name = input('姓名：'); print('你好', name)", "all")
        self.wait(lambda _: self.session.snapshot()["status"] == "input")
        self.session.submit_input("小明")
        self.wait(lambda _: "你好 小明" in self.output())

    def test_all_clears_history_and_output_keeps_run_identity(self):
        self.session.execute("x = 7; print('OLD_RESULT')", "selection", "inline-run")
        self.wait(lambda events: any(e["type"] == "stdout" and "OLD_RESULT" in e["text"] for e in events))
        self.wait(lambda _: self.session.snapshot()["status"] == "idle")
        old = [e for e in self.session.events()["events"] if e["type"] == "stdout"]
        self.assertTrue(all(e["run_id"] == "inline-run" and e["mode"] == "selection" for e in old))
        self.session.execute("print(x + 1)", "all", "all-run")
        self.wait(lambda events: any(e["type"] == "stdout" and "8" in e["text"] for e in events))
        self.assertNotIn("OLD_RESULT", self.output())
        self.assertTrue(all(e["run_id"] == "all-run" for e in self.session.events()["events"]))

    def test_multiline_statement_from_closing_line_executes_in_session(self):
        from execution import statement_at
        source = "matrix = [[0.0,0.0],\n          [0.22,0.8]]\nprint(matrix[-1])\n"
        statement = statement_at(source, 2)
        self.run_code(statement["source"], statement["mode"])
        self.run_code("matrix[-1]")
        self.wait(lambda _: "[0.22, 0.8]" in self.output())
        self.assertNotIn("IndentationError", self.output())

    def test_streaming_busy_stop_and_bounded_output(self):
        self.session.execute("import time\nprint('first', flush=True)\ntime.sleep(30)", "all")
        self.wait(lambda _: "first" in self.output())
        self.assertEqual(self.session.snapshot()["status"], "running")
        with self.assertRaises(ValueError):
            self.session.execute("1", "line")
        old_pid = self.session.process.pid
        self.session.reset()
        self.assertNotEqual(old_pid, self.session.process.pid)
        self.run_code("'x' in globals()")
        self.wait(lambda _: "False" in self.output())
        self.session.execute("while True: print('x' * 1000)", "all")
        time.sleep(.25)
        self.session.reset()
        self.assertLessEqual(self.session.event_bytes, self.session.MAX_EVENT_BYTES)

    def test_exit_and_interpreter_validation(self):
        from session import probe_interpreter
        self.assertIn("Python", probe_interpreter(sys.executable)["label"])
        with self.assertRaises(ValueError):
            probe_interpreter(str(ROOT / "missing-python.exe"))
        self.run_code("exit()")
        self.wait(lambda _: self.session.snapshot()["status"] == "exited")
        self.session.reset()
        self.run_code("__name__")
        self.wait(lambda _: "__main__" in self.output())

    @unittest.skipUnless(sys.platform == "win32", "Windows process tree regression")
    def test_children_reclaimed_after_worker_crash(self):
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.session.execute("import subprocess, sys, os\np = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\nprint('CHILD', p.pid, flush=True)\nos._exit(0)", "all")
        self.wait(lambda _: "CHILD" in self.output() and self.session.snapshot()["status"] == "exited")
        pid = int(self.output().split("CHILD ")[1].split()[0])
        handle = kernel.OpenProcess(0x100000, False, pid)
        try:
            self.session.reset()
            if handle:
                self.assertEqual(kernel.WaitForSingleObject(handle, 2000), 0, "worker child leaked after reset")
        finally:
            if handle:
                kernel.CloseHandle(handle)
            import subprocess
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)


class FileTests(unittest.TestCase):
    def test_discovery_finds_project_path_and_conda_environments(self):
        from interpreters import candidate_paths, discover_interpreters
        with scratch_directory() as folder:
            home = Path(folder)
            project = home / "project"
            paths = [project / ".venv/Scripts/python.exe", home / "path-python/python.exe",
                     home / "custom-conda/Scripts/python.exe", home / "AppData/Local/Programs/Python/Python313/python.exe"]
            for executable in paths:
                executable.parent.mkdir(parents=True, exist_ok=True)
                executable.write_text("test fixture", encoding="utf-8")
            (home / ".conda").mkdir()
            (home / ".conda/environments.txt").write_text(str(home / "custom-conda"), encoding="utf-8")
            env = {"PATH": str(home / "path-python"), "LOCALAPPDATA": str(home / "AppData/Local"), "USERPROFILE": str(home)}
            candidates = candidate_paths(project, environ=env, home=home)
            normalized = {str(Path(item["path"]).resolve()).casefold() for item in candidates}
            for executable in paths:
                self.assertIn(str(executable.resolve()).casefold(), normalized)
            self.assertEqual(len(normalized), len(candidates))
        detected = discover_interpreters(ROOT)
        self.assertIn(str(Path(sys.executable).resolve()).casefold(), {item["path"].casefold() for item in detected})

    def test_chrome_launcher_discovery(self):
        from app import find_chrome
        installed = Path("C:/Program Files/Google/Chrome/Application/chrome.exe")
        if not installed.exists():
            self.skipTest("Chrome not installed in this test environment")
        self.assertEqual(Path(find_chrome()).resolve(), installed.resolve())

    def test_encoding_and_failed_save_preserve_original(self):
        from app import read_document, save_document
        with scratch_directory() as folder:
            path = Path(folder) / "中文.py"
            path.write_bytes("# coding: gbk\nprint('中文')\n".encode("gbk"))
            doc = read_document(path)
            self.assertIn("中文", doc["text"])
            save_document(path, doc["text"] + "x=1\n", doc["encoding"])
            before = path.read_bytes()
            with self.assertRaises(UnicodeEncodeError):
                save_document(path, doc["text"] + "# 😀", doc["encoding"])
            self.assertEqual(path.read_bytes(), before)
            bom = Path(folder) / "bom.py"
            bom.write_bytes(b"\xef\xbb\xbfx=1\r\n")
            self.assertEqual(read_document(bom)["encoding"], "utf-8-sig")


class HttpTests(unittest.TestCase):
    def test_folder_required_before_new_and_save_defaults_to_folder(self):
        from app import Application
        with scratch_directory() as folder:
            chosen = {"folder": ""}
            prompts = []

            def choose(kind, initial):
                prompts.append((kind, initial))
                return chosen["folder"] if kind == "folder" else str(Path(folder) / "new.py")

            application = Application(Path(folder), chooser=choose)
            try:
                original = application.state()
                with self.assertRaisesRegex(ValueError, "选择.*文件夹"):
                    application.action("/api/file/new", {})
                self.assertEqual(application.state()["document_id"], original["document_id"])
                self.assertEqual(application.action("/api/folder/select", {}), {"cancelled": True})
                self.assertIsNone(application.state()["folder"])
                chosen["folder"] = str(Path(folder) / "missing")
                with self.assertRaises(ValueError):
                    application.action("/api/folder/select", {})
                chosen["folder"] = folder
                selected = application.action("/api/folder/select", {})
                self.assertEqual(selected["folder"], str(Path(folder).resolve()))
                self.assertEqual(selected["session"]["generation"], original["session"]["generation"])
                with self.assertRaises(ValueError):
                    application.action("/api/file/new", {})
                fresh = application.action("/api/file/new", {"name": "new"})
                self.assertEqual(Path(fresh["path"]).name, "new.py")
                self.assertTrue((Path(folder) / "new.py").is_file())
                self.assertEqual(application.session.cwd, str(Path(folder).resolve()))
                application.action("/api/file/save", {"text": "print('new')", "document_id": fresh["document_id"]})
                self.assertEqual((Path(folder) / "new.py").read_text(encoding="utf-8"), "print('new')")
                original_id = application.document_id
                for name in ("new.py", "../escape.py", "CON.py", "bad/name", "", "bad?.py"):
                    with self.assertRaises((ValueError, OSError)):
                        application.action("/api/file/new", {"name": name})
                    self.assertEqual(application.document_id, original_id)
                renamed = application.action("/api/file/rename", {"name": "renamed", "document_id": original_id})
                self.assertEqual(Path(renamed["path"]).name, "renamed.py")
                self.assertFalse((Path(folder) / "new.py").exists())
                self.assertEqual((Path(folder) / "renamed.py").read_text(encoding="utf-8"), "print('new')")
                (Path(folder) / "taken.py").write_text("KEEP", encoding="utf-8")
                with self.assertRaises(ValueError):
                    application.action("/api/file/rename", {"name": "taken.py", "document_id": application.document_id})
                self.assertEqual((Path(folder) / "taken.py").read_text(encoding="utf-8"), "KEEP")
                application.session.execute("kept = 23", "line")
                deadline = time.monotonic() + 5
                while application.session.snapshot()["status"] != "idle" and time.monotonic() < deadline:
                    time.sleep(.02)
                application.action("/api/file/rename", {"name": "Renamed.py", "document_id": application.document_id})
                application.session.execute("print(kept, __file__)", "line")
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    output = "".join(e.get("text", "") for e in application.session.events()["events"] if e["type"] == "stdout")
                    if "23" in output and "Renamed.py" in output:
                        break
                    time.sleep(.02)
                else:
                    self.fail("rename lost variables or runtime filename")
                with self.assertRaises(ValueError):
                    application.action("/api/file/rename", {"name": "other", "document_id": original_id})
            finally:
                application.close()

    def test_auth_files_and_execution(self):
        from app import Application, make_server
        with scratch_directory() as folder:
            path = Path(folder) / "file.py"
            path.write_text("x = 7\n", encoding="utf-8")
            application = Application(Path(folder), chooser=lambda kind, _: sys.executable if kind == "interpreter" else str(path))
            server = make_server(application)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"

            def request(route, data=None, token=True, origin=base):
                headers = {"Origin": origin}
                if token:
                    headers["X-Editor-Token"] = application.token
                body = None if data is None else json.dumps(data).encode()
                return urllib.request.urlopen(urllib.request.Request(base + route, body, headers), timeout=10)

            try:
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    request("/api/state", token=False)
                self.assertEqual(denied.exception.code, 403)
                statement = json.load(request("/api/statement", {"source": "values = [[0, 0],\n          [0.22, 0.8]]", "line": 2}))
                self.assertEqual(statement["start_line"], 1)
                self.assertTrue(statement["source"].startswith("values = [["))
                self.assertEqual(statement["mode"], "selection")
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    request("/api/execute", {"source": "1", "mode": "line"}, origin="http://evil.example")
                self.assertEqual(denied.exception.code, 403)
                opened = json.load(request("/api/file/open", {}))
                self.assertEqual(opened["text"], "x = 7\n")
                json.load(request("/api/file/save", {"text": "print('保存成功')\n", "document_id": opened.get("document_id")}))
                self.assertIn("保存成功", path.read_text(encoding="utf-8"))
                before = path.read_bytes()
                with self.assertRaises(urllib.error.HTTPError):
                    request("/api/file/save", {"text": "", "document_id": "stale-tab"})
                self.assertEqual(path.read_bytes(), before)
                added = json.load(request("/api/interpreters/add", {}))
                self.assertEqual(len(added["interpreters"]), 1)
                self.assertTrue((Path(folder) / "settings.json").exists())
                discovered = json.load(request("/api/interpreters/discover", {}))
                self.assertIn(str(Path(sys.executable).resolve()), [item["path"] for item in discovered["interpreters"]])
                selected_entry = next(item for item in discovered["interpreters"] if item["path"] == str(Path(sys.executable).resolve()))
                self.assertIn("source", selected_entry)
                json.load(request("/api/interpreters/add", {"path": selected_entry["path"]}))
                with self.assertRaises(urllib.error.HTTPError):
                    request("/api/interpreters/select", {"path": "missing.exe"})
                switched = json.load(request("/api/interpreters/select", {"path": sys.executable}))
                self.assertEqual(switched["session"]["status"], "idle")
                json.load(request("/api/execute", {"source": "40 + 2", "mode": "line"}))
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    events = json.load(request("/api/events?after=0"))["events"]
                    if "42" in "".join(e.get("text", "") for e in events if e["type"] == "stdout"):
                        break
                    time.sleep(.03)
                else:
                    self.fail("HTTP execution did not produce 42")
            finally:
                server.shutdown()
                server.server_close()
                application.close()


if __name__ == "__main__":
    unittest.main()
