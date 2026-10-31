"""Isolated browser acceptance server with deterministic file-picker answers."""
import json
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import Application, make_server


def main():
    workspace = ROOT / "tests/browser-workspace"
    workspace.mkdir(exist_ok=True)
    application = Application(workspace, chooser=lambda kind, _: str(workspace) if kind == "folder" else str(workspace / "example.py"))
    server = make_server(application)
    running = ROOT / "tests/.browser-running.json"
    url = f"http://127.0.0.1:{server.server_port}/#token={application.token}"
    running.write_text(json.dumps({"url": url}), encoding="utf-8")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print("Isolated browser test server ready", flush=True)
    try:
        while not application.check_shutdown():
            time.sleep(.1)
    except KeyboardInterrupt:
        pass
    finally:
        application.close()
        server.shutdown()
        server.server_close()
        running.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
