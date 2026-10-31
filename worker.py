"""Execution process. The control connection never shares program stdout/stdin."""
import ast
import __future__
import builtins
import code
import json
import os
import sys
import traceback
import types
import threading
from multiprocessing.connection import Client


def main():
    sys.stdout.reconfigure(newline="\n")
    sys.stderr.reconfigure(newline="\n")
    connection = Client(("127.0.0.1", int(sys.argv[1])), authkey=bytes.fromhex(os.environ.pop("EDITOR_WORKER_KEY")))

    send_lock = threading.Lock()
    active = {"run_id": None, "mode": None}

    def send(kind, **data):
        with send_lock:
            connection.send_bytes(json.dumps({"type": kind, **active, **data}, ensure_ascii=False).encode("utf-8"))

    class OutputStream:
        def __init__(self, original, kind):
            self.original, self.kind = original, kind

        def write(self, text):
            if not isinstance(text, str):
                raise TypeError("write() requires str")
            for start in range(0, len(text), 4096):
                send(self.kind, text=text[start:start + 4096])
            return len(text)

        def flush(self):
            self.original.flush()

        def __getattr__(self, name):
            return getattr(self.original, name)

    sys.stdout = OutputStream(sys.stdout, "stdout")
    sys.stderr = OutputStream(sys.stderr, "stderr")

    filename = sys.argv[2] or "<编辑器>"
    sys.argv = [filename]
    sys.path[0] = os.getcwd()
    module = types.ModuleType("__main__")
    sys.modules["__main__"] = module
    namespace = module.__dict__
    if not filename.startswith("<"):
        namespace["__file__"] = filename
    class Console(code.InteractiveConsole):
        failed = False

        def showsyntaxerror(self, *args, **kwargs):
            self.failed = True
            super().showsyntaxerror(*args, **kwargs)

        def showtraceback(self):
            self.failed = True
            super().showtraceback()

    console = Console(namespace, filename=filename)

    def editor_input(prompt=""):
        print(prompt, end="", flush=True)
        send("input")
        line = sys.stdin.readline()
        if not line:
            raise EOFError("输入已关闭")
        send("running")
        return line.rstrip("\r\n")

    builtins.input = editor_input
    send("ready")
    while True:
        try:
            command = json.loads(connection.recv_bytes().decode("utf-8"))
        except (EOFError, OSError):
            break
        if command["action"] == "cancel":
            console.resetbuffer()
            send("done", more=False, success=False)
            continue
        if command["action"] == "filename":
            filename = command["filename"]
            console.filename = filename
            namespace["__file__"] = filename
            sys.argv[0] = filename
            continue
        source, mode = command["source"], command["mode"]
        active.update(run_id=command["run_id"], mode=mode)
        more = False
        success = True
        console.failed = False
        try:
            if mode == "line":
                more = console.push(source)
                success = not more and not console.failed
            else:
                source = "\n" * (command.get("start_line", 1) - 1) + source
                compiled = console.compile(source, filename, "exec")
                if compiled is None:
                    raise SyntaxError("代码不完整，请选中完整的语句或代码块")
                tree = ast.parse(source, filename, "exec")
                future_flags = compiled.co_flags & sum(getattr(__future__, name).compiler_flag for name in __future__.all_feature_names)
                if tree.body and isinstance(tree.body[-1], ast.Expr) and (mode == "incremental" or mode == "selection" and len(tree.body) == 1):
                    if len(tree.body) > 1:
                        exec(compile(ast.Module(body=tree.body[:-1], type_ignores=[]), filename, "exec", flags=future_flags, dont_inherit=True), namespace)
                    sys.displayhook(eval(compile(ast.Expression(tree.body[-1].value), filename, "eval", flags=future_flags, dont_inherit=True), namespace))
                else:
                    exec(compiled, namespace)
        except SystemExit:
            send("exit")
            break
        except BaseException as error:
            success = False
            traceback.print_exception(type(error), error, error.__traceback__.tb_next)
        finally:
            sys.stdout.flush()
            sys.stderr.flush()
        send("done", more=more, success=success)
    connection.close()


if __name__ == "__main__":
    main()
