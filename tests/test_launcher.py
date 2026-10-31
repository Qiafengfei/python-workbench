"""Windows launcher checks against isolated, real editor processes."""
import ctypes
import json
import os
import shutil
import subprocess
import sys
import time
import unittest
import urllib.request
from pathlib import Path

from test_editor import ROOT, scratch_directory


@unittest.skipUnless(sys.platform == "win32", "Windows launchers")
class LauncherTests(unittest.TestCase):
    def test_python_search_skips_empty_alias_and_unusable_interpreters(self):
        with scratch_directory() as temporary:
            alias = Path(temporary) / "WindowsApps"
            alias.mkdir()
            (alias / "python.exe").write_bytes(b"")
            broken = Path(temporary) / "broken-python"
            broken.mkdir()
            # A stale, non-executable install must not hide a usable later PATH entry either.
            (broken / "python.exe").write_bytes(b"invalid executable")
            search_paths = [str(alias), str(broken), str(Path(sys.executable).parent)]
            script = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
            script += "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($env:EDITOR_TEST_LAUNCHER)); "
            script += "$method = $assembly.GetType('Launcher').GetMethod('FindPython', [Reflection.BindingFlags]'Static,NonPublic'); "
            script += "$found = $method.Invoke($null, [object[]]@($env:EDITOR_TEST_PREFERRED, $env:EDITOR_TEST_PATH)); "
            script += "if ($null -eq $found) { 'null' } else { ConvertTo-Json -Compress -InputObject $found }"
            environment = {**os.environ, "EDITOR_TEST_LAUNCHER": str(ROOT / "PythonWorkbench.exe"),
                           "EDITOR_TEST_PREFERRED": str(Path(temporary) / "missing/python.exe")}
            for paths, expected in [(search_paths, str(Path(sys.executable).resolve())), (search_paths[:2], None)]:
                result = subprocess.run(
                    ["powershell.exe", "-NoProfile", "-Command", script],
                    env={**environment, "EDITOR_TEST_PATH": os.pathsep.join(paths)},
                    capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=20,
                )
                self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
                found = json.loads(result.stdout.decode("utf-8-sig"))
                self.assertEqual(found, expected)

    def test_exe_starts_one_hidden_editor_after_moving(self):
        executable = ROOT / "PythonWorkbench.exe"
        self.assertTrue(executable.is_file(), "the distributable EXE launcher is missing")
        with scratch_directory() as temporary:
            parent = Path(temporary)
            project = parent / "中文 空格 编辑器"
            project.mkdir()
            for source in ROOT.glob("*.py"):
                shutil.copy2(source, project)
            shutil.copy2(project / "app.py", project / "editor_app.py")
            shutil.copy2(executable, project)
            shutil.copytree(ROOT / "web", project / "web")
            workspace = ROOT / "tests/browser-workspace"
            workspace.mkdir(exist_ok=True)
            (workspace / "example.py").write_text("x = 7\n", encoding="utf-8")
            # Keep the real application, UI and worker; only the picker is deterministic.
            (project / "app.py").write_text(
                "import ctypes, json, sys\nfrom pathlib import Path\nimport editor_app\n"
                "kernel = ctypes.WinDLL('kernel32')\nkernel.GetConsoleWindow.restype = ctypes.c_void_p\n"
                "window = kernel.GetConsoleWindow()\n"
                "visible = bool(window and ctypes.windll.user32.IsWindowVisible(ctypes.c_void_p(window)))\n"
                "Path(__file__).with_name('launch-observed.json').write_text(json.dumps({'console': bool(window), 'visible': visible}))\n"
                f"workspace = Path({str(workspace)!r})\n"
                "OriginalApplication = editor_app.Application\n"
                "class TestApplication(OriginalApplication):\n"
                "    def __init__(self, *args, **kwargs):\n"
                "        kwargs['chooser'] = lambda kind, _: str(workspace if kind == 'folder' else workspace / 'example.py')\n"
                "        super().__init__(*args, **kwargs)\n"
                "editor_app.Application = TestApplication\n"
                "sys.argv[1:] = ['--no-browser', '--no-dialogs']\neditor_app.main()\n",
                encoding="utf-8",
            )
            running = None

            def wait_running():
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline:
                    try:
                        return json.loads((project / ".running.json").read_text())
                    except (OSError, ValueError):
                        time.sleep(.05)
                self.fail("launcher did not start the editor")

            def request(route, data=None):
                base, token = running["url"].split("/#token=")
                body = None if data is None else json.dumps(data).encode()
                headers = {"Origin": base, "X-Editor-Token": token, "Content-Type": "application/json"}
                with urllib.request.urlopen(urllib.request.Request(base + route, body, headers), timeout=5) as response:
                    return json.load(response)

            def wait_stopped():
                deadline = time.monotonic() + 12
                while (project / ".running.json").exists() and time.monotonic() < deadline:
                    time.sleep(.1)
                self.assertFalse((project / ".running.json").exists(), "editor failed to close")
                # The running file is removed just before the process closes its cwd/lock handles.
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
                kernel.OpenProcess.restype = ctypes.c_void_p
                kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
                kernel.CloseHandle.argtypes = [ctypes.c_void_p]
                handle = kernel.OpenProcess(0x100000, False, running["pid"])
                if handle:
                    try:
                        self.assertEqual(kernel.WaitForSingleObject(handle, 10000), 0, "backend process stayed resident")
                    finally:
                        kernel.CloseHandle(handle)

            try:
                for location in ("original", "moved"):
                    launcher = subprocess.Popen([str(project / "PythonWorkbench.exe")])
                    self.assertEqual(launcher.wait(timeout=5), 0, "EXE launcher stayed resident or failed")
                    running = wait_running()
                    observed = json.loads((project / "launch-observed.json").read_text())
                    self.assertFalse(observed["visible"], "launcher displayed a console window")
                    self.assertFalse(observed["console"], "EXE created an unnecessary console")
                    request("/api/client", {"id": "acceptance", "active": True, "revision": 1})
                    document = request("/api/file/open", {})
                    request("/api/execute", {"source": "print(6 * 7)", "mode": "all"})
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        events = request("/api/events?after=0")["events"]
                        if "42" in "".join(event.get("text", "") for event in events if event["type"] == "stdout"):
                            break
                        time.sleep(.05)
                    else:
                        self.fail("launched editor could not execute Python")
                    request("/api/file/save", {"text": "x = 7\n", "document_id": document["document_id"]})
                    # Repeated EXE launches must reuse the original backend.
                    original_pid = running["pid"]
                    duplicate = subprocess.Popen([str(project / "PythonWorkbench.exe")])
                    self.assertEqual(duplicate.wait(timeout=8), 0)
                    time.sleep(.8)
                    self.assertEqual(wait_running()["pid"], original_pid)
                    request("/api/client", {"id": "acceptance", "active": False, "revision": 2})
                    if os.environ.get("EDITOR_LAUNCHER_BROWSER_TEST") == "1":
                        # Hold the backend while Chrome starts, then let its real page close it.
                        request("/api/client", {"id": "acceptance", "active": True, "revision": 3})
                        environment = {**os.environ, "EDITOR_TEST_RUNNING": str(project / ".running.json")}
                        # The harness removes this test client once the browser has registered.
                        environment["EDITOR_LAUNCHER_CLIENT"] = "acceptance"
                        checked = subprocess.run(["node", str(ROOT / "tests/browser_smoke.mjs")],
                                                 env=environment, capture_output=True, timeout=150)
                        self.assertEqual(checked.returncode, 0, (checked.stdout + checked.stderr).decode("utf-8", "replace"))
                        print(checked.stdout.decode("utf-8", "replace"))
                    wait_stopped()
                    running = None
                    print(f"PASS: EXE at {location} location, hidden window, execution, shared instance and shutdown")
                    if location == "original":
                        destination = parent / "移动后的 编辑器"
                        project.rename(destination)
                        project = destination
            finally:
                if running and (project / ".running.json").exists():
                    try:
                        request("/api/shutdown", {})
                        wait_stopped()
                    except OSError:
                        pass


if __name__ == "__main__":
    unittest.main()
