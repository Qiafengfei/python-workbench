"""Discover installed Python and virtual environments without crawling disks."""
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from session import ROOT, probe_interpreter


def registry_paths():
    if os.name != "nt":
        return []
    import winreg
    found = []

    def children(key):
        index = 0
        while True:
            try:
                yield winreg.EnumKey(key, index)
                index += 1
            except OSError:
                return

    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, r"Software\Python", 0, winreg.KEY_READ | view) as companies:
                    for company in children(companies):
                        with winreg.OpenKey(companies, company) as tags:
                            for tag in children(tags):
                                try:
                                    with winreg.OpenKey(tags, tag + r"\InstallPath") as install:
                                        try:
                                            value = winreg.QueryValueEx(install, "ExecutablePath")[0]
                                        except OSError:
                                            value = str(Path(winreg.QueryValueEx(install, "")[0]) / "python.exe")
                                        found.append(value)
                                except OSError:
                                    continue
            except OSError:
                continue
    return found


def candidate_paths(project=ROOT, environ=None, home=None):
    env = os.environ if environ is None else environ
    home = Path.home() if home is None else Path(home)
    found = {}

    def add(path, source):
        try:
            path = Path(path).expanduser().resolve()
            if "windowsapps" in str(path).casefold() or str(path).startswith("\\\\"):
                return
            key = os.path.normcase(str(path))
            if key not in found and path.is_file():
                found[key] = {"path": str(path), "source": source}
        except (OSError, ValueError):
            pass

    def environment(prefix, source):
        for relative in ("python.exe", "Scripts/python.exe", "bin/python", "bin/python3"):
            add(Path(prefix) / relative, source)

    def child_environments(parent, source):
        try:
            for directory in sorted(Path(parent).iterdir())[:128]:
                if directory.is_dir():
                    environment(directory, source)
        except OSError:
            pass

    add(sys.executable, "编辑器启动环境")
    for name in (".venv", "venv", "env", ".env"):
        environment(Path(project) / name, "项目虚拟环境")
    for variable in ("VIRTUAL_ENV", "CONDA_PREFIX"):
        if env.get(variable):
            environment(env[variable], "当前虚拟环境")
    for directory in env.get("PATH", "").split(os.pathsep):
        if directory.strip().strip('"'):
            for name in ("python.exe", "python3.exe", "python", "python3"):
                add(Path(directory.strip().strip('"')) / name, "PATH")
    local = Path(env.get("LOCALAPPDATA", home / "AppData/Local"))
    child_environments(local / "Programs/Python", "本地 Python 安装")
    for variable, fallback in (("ProgramFiles", "C:/Program Files"), ("ProgramFiles(x86)", "C:/Program Files (x86)")):
        try:
            for directory in Path(env.get(variable, fallback)).glob("Python*"):
                environment(directory, "系统 Python 安装")
        except OSError:
            pass
    for path in registry_paths():
        add(path, "Windows 注册的 Python")
    for prefix in {Path(sys.prefix), Path(sys.base_prefix), Path(sys.prefix).parent.parent}:
        if (prefix / "conda-meta").is_dir():
            environment(prefix, "Conda 基础环境")
            child_environments(prefix / "envs", "Conda 环境")
    for name in ("anaconda3", "miniconda3", "miniforge3", "mambaforge"):
        for parent in (home, local):
            environment(parent / name, "Conda 基础环境")
            child_environments(parent / name / "envs", "Conda 环境")
    try:
        for prefix in (home / ".conda/environments.txt").read_text(encoding="utf-8-sig").splitlines():
            if prefix.strip() and not prefix.lstrip().startswith("#"):
                environment(prefix.strip(), "Conda 环境")
    except (OSError, UnicodeError):
        pass
    child_environments(home / ".conda/envs", "Conda 环境")
    for directory in env.get("CONDA_ENVS_PATH", "").split(os.pathsep):
        if directory:
            child_environments(directory, "Conda 环境")
    child_environments(env.get("WORKON_HOME", home / ".virtualenvs"), "Virtualenv 环境")
    return list(found.values())[:64]


def discover_interpreters(project=ROOT):
    def validate(candidate):
        try:
            return {**probe_interpreter(candidate["path"]), "source": candidate["source"]}
        except ValueError:
            return None

    # Every validation has a five-second timeout; only check known local locations.
    with ThreadPoolExecutor(max_workers=8) as pool:
        return [result for result in pool.map(validate, candidate_paths(project)) if result]
