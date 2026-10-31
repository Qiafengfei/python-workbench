"""Real process regressions for closing pages and repeated startup."""
import json
import shutil
import subprocess
import sys
import time
import unittest
import urllib.request
import urllib.error
from pathlib import Path

from test_editor import scratch_directory, ROOT


class LifecycleTests(unittest.TestCase):
    def test_last_page_close_exits_and_releases_directory(self):
        with scratch_directory() as folder:
            project = Path(folder) / "editor"
            project.mkdir()
            for source in ROOT.glob("*.py"):
                shutil.copy2(source, project)
            processes = []

            def launch(dialogs=False):
                process = subprocess.Popen(
                    [sys.executable, "app.py", "--no-browser", *([] if dialogs else ["--no-dialogs"])],
                    cwd=project, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                )
                processes.append(process)
                return process

            def read_running():
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    try:
                        return json.loads((project / ".running.json").read_text())
                    except (OSError, ValueError):
                        time.sleep(.05)
                self.fail("editor did not start")

            try:
                first = launch()
                running = read_running()
                base, token = running["url"].split("/#token=")

                def client(client_id, active, revision):
                    request = urllib.request.Request(
                        base + "/api/client",
                        data=json.dumps({"id": client_id, "active": active, "revision": revision}).encode(),
                        headers={"X-Editor-Token": token, "Origin": base, "Content-Type": "application/json"},
                    )
                    try:
                        with urllib.request.urlopen(request, timeout=5) as response:
                            return json.load(response)
                    except urllib.error.HTTPError as error:
                        self.fail(f"page lifecycle request failed: {error.read().decode()}")

                self.assertEqual(client("page-one", True, 1), {"ok": True})
                duplicate = launch()
                try:
                    duplicate.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.fail("repeated startup left another editor process running")
                self.assertEqual(duplicate.returncode, 0)
                self.assertEqual(read_running()["pid"], first.pid)

                # A refresh reconnects with a new page; delayed old messages cannot revive it.
                client("page-one", False, 2)
                client("page-two", True, 1)
                client("page-one", True, 1)
                time.sleep(4)
                self.assertIsNone(first.poll(), "refresh killed the session")
                # Closing one of two pages must leave the other usable.
                client("page-three", True, 1)
                client("page-two", False, 2)
                time.sleep(4)
                self.assertIsNone(first.poll(), "closing one page killed another page's session")
                client("page-three", False, 2)
                try:
                    first.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.fail("closing the last page left the editor running")
                self.assertEqual(first.returncode, 0)
                self.assertFalse((project / ".running.json").exists())
                moved = project.with_name("renamed-editor")
                project.rename(moved)
                moved.rename(project)
                # Stale lock files must not prevent a subsequent startup.
                restarted = launch(dialogs=sys.platform == "win32")
                new_running = read_running()
                base, token = new_running["url"].split("/#token=")
                self.assertEqual(new_running["pid"], restarted.pid)
                client("restarted-page", True, 1)
                client("restarted-page", False, 2)
                restarted.wait(timeout=10)
                self.assertEqual(restarted.returncode, 0)
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=10)
                    error = process.stderr.read().decode("utf-8", "replace")
                    process.stderr.close()
                    if error:
                        print(error)


if __name__ == "__main__":
    unittest.main()
