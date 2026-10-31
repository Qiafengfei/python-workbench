"""Regression: the built GUI launcher must open a real, connected browser page."""
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


@unittest.skipUnless(sys.platform == "win32", "Windows GUI launcher")
class LauncherBrowserTests(unittest.TestCase):
    def test_exe_automatically_opens_a_connected_browser_page(self):
        from app import find_chrome
        if not find_chrome():
            self.skipTest("Chrome is not installed")
        profile = ROOT / "tests/launcher-browser-profile"
        profile.mkdir(exist_ok=True)
        port_file = profile / "DevToolsActivePort"
        port_file.unlink(missing_ok=True)
        with scratch_directory() as temporary:
            project = Path(temporary) / "editor"
            project.mkdir()
            for source in ROOT.glob("*.py"):
                shutil.copy2(source, project)
            shutil.copy2(project / "app.py", project / "editor_app.py")
            shutil.copytree(ROOT / "web", project / "web")
            (project / "scripts").mkdir()
            for name in ("Launcher.cs", "build-launcher.ps1"):
                shutil.copy2(ROOT / "scripts" / name, project / "scripts" / name)
            artifact = project / "PythonWorkbench.exe"
            artifact.write_bytes(b"low-integrity build fixture")
            initial_labels = subprocess.check_output(["icacls.exe", str(artifact)],
                                                    creationflags=subprocess.CREATE_NO_WINDOW)
            if b"Low Mandatory Level" not in initial_labels:
                self.skipTest("this regression requires a managed Low-integrity workspace fixture")

            def read_dacl():
                command = "[IO.File]::GetAccessControl($env:EDITOR_TEST_ARTIFACT).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)"
                return subprocess.check_output(["powershell.exe", "-NoProfile", "-Command", command],
                    env={**os.environ, "EDITOR_TEST_ARTIFACT": str(artifact)},
                    creationflags=subprocess.CREATE_NO_WINDOW).strip()

            original_dacl = read_dacl()
            built = subprocess.run(
                ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                 str(project / "scripts/build-launcher.ps1")],
                capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=30,
            )
            self.assertEqual(built.returncode, 0, built.stderr.decode("utf-8", "replace"))
            self.assertEqual(read_dacl(), original_dacl, "publishing must preserve the executable's access permissions")
            self.assertIn(b"Medium Mandatory Level", subprocess.check_output(["icacls.exe", str(artifact)],
                          creationflags=subprocess.CREATE_NO_WINDOW))
            workspace = ROOT / "tests/browser-workspace"
            workspace.mkdir(exist_ok=True)
            (workspace / "example.py").write_text("x = 7\n", encoding="utf-8")
            # Preserve the production automatic-browser path. Only add isolated Chrome flags
            # and record actual page registration; do not open the browser from the test runner.
            (project / "app.py").write_text(
                "import json, subprocess, sys\nfrom pathlib import Path\nimport editor_app as app\n"
                f"profile = Path({str(profile)!r})\nworkspace = Path({str(workspace)!r})\n"
                "chrome = app.find_chrome()\noriginal_popen = subprocess.Popen\n"
                "def popen(arguments, *args, **kwargs):\n"
                "    if isinstance(arguments, (list, tuple)) and arguments[0] == chrome:\n"
                "        arguments = [chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + str(profile), *arguments[1:]]\n"
                "    return original_popen(arguments, *args, **kwargs)\n"
                "subprocess.Popen = popen\nOriginalApplication = app.Application\n"
                "class TestApplication(OriginalApplication):\n"
                "    def __init__(self, *args, **kwargs):\n"
                "        kwargs['chooser'] = lambda kind, _: str(workspace if kind == 'folder' else workspace / 'example.py')\n"
                "        super().__init__(*args, **kwargs)\n"
                "    def action(self, route, data):\n"
                "        result = super().action(route, data)\n"
                "        if route == '/api/client' and data.get('active'):\n"
                "            Path(__file__).with_name('browser-connected').write_text('connected')\n"
                "        return result\n"
                "app.Application = TestApplication\nsys.argv[1:] = ['--no-dialogs']\napp.main()\n",
                encoding="utf-8",
            )
            running = None
            port = None
            try:
                launcher = subprocess.Popen([str(project / "PythonWorkbench.exe")],
                                            creationflags=subprocess.CREATE_NO_WINDOW)
                self.assertEqual(launcher.wait(timeout=8), 0)
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline:
                    try:
                        running = json.loads((project / ".running.json").read_text())
                        if port_file.exists():
                            port = int(port_file.read_text().splitlines()[0])
                        if port and (project / "browser-connected").exists():
                            break
                    except (OSError, ValueError):
                        pass
                    time.sleep(.1)
                self.assertTrue((project / "browser-connected").exists(),
                                "EXE started the backend but failed to open a real connected browser page")
                if os.environ.get("EDITOR_LAUNCHER_BROWSER_TEST") == "1":
                    checked = subprocess.run(
                        ["node", str(ROOT / "tests/browser_smoke.mjs")],
                        env={**os.environ, "EDITOR_TEST_RUNNING": str(project / ".running.json"),
                             "EDITOR_TEST_BROWSER_PORT": str(port)},
                        capture_output=True, timeout=150,
                    )
                    self.assertEqual(checked.returncode, 0,
                                     (checked.stdout + checked.stderr).decode("utf-8", "replace"))
                    print(checked.stdout.decode("utf-8", "replace"))
                print("PASS: EXE itself automatically opened a real browser page and the page connected")
            finally:
                if running and (project / ".running.json").exists():
                    base, token = running["url"].split("/#token=")
                    request = urllib.request.Request(base + "/api/shutdown", data=b"{}",
                        headers={"X-Editor-Token": token, "Origin": base, "Content-Type": "application/json"})
                    try:
                        with urllib.request.urlopen(request, timeout=3) as response:
                            response.read()
                    except OSError:
                        pass
                if port:
                    # Close only this dedicated test browser through its own debugging endpoint.
                    close_script = "const r=await fetch('http://127.0.0.1:'+process.env.EDITOR_TEST_BROWSER_PORT+'/json/version');const b=await r.json();const s=new WebSocket(b.webSocketDebuggerUrl);s.onopen=()=>s.send(JSON.stringify({id:1,method:'Browser.close'}));await new Promise(resolve=>{s.onclose=resolve;s.onerror=resolve;setTimeout(resolve,3000)});"
                    subprocess.run(["node", "--input-type=module", "-e", close_script],
                        env={**os.environ, "EDITOR_TEST_BROWSER_PORT": str(port)},
                        capture_output=True, timeout=8)
                deadline = time.monotonic() + 10
                while (project / ".running.json").exists() and time.monotonic() < deadline:
                    time.sleep(.1)
                time.sleep(.3)  # The process releases its cwd immediately after removing .running.json.


if __name__ == "__main__":
    unittest.main()
