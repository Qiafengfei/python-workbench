using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Python Workbench")]
[assembly: AssemblyDescription("轻量 Python 编辑器启动器")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string application = Path.Combine(folder, "app.py");
            if (!File.Exists(application))
                throw new FileNotFoundException("找不到编辑器文件 app.py。请将启动器放回完整的 python-workbench 文件夹。", application);
            foreach (string argument in args)
                if (argument != "--no-browser" && argument != "--no-dialogs")
                    throw new ArgumentException("不支持此启动参数：" + argument);
            string python = FindPython(@"D:\Anaconda\Anaconda3\python.exe", Environment.GetEnvironmentVariable("PATH") ?? "");
            if (python == null)
                throw new FileNotFoundException("未找到 Python。请安装 Python 3.10 或更新版本（含 Tkinter），并将其加入 PATH 后重试。\n\n当前会优先查找 D:\\Anaconda\\Anaconda3\\python.exe。");
            var start = new ProcessStartInfo
            {
                FileName = python,
                Arguments = "\"" + application + "\"" + (args.Length == 0 ? "" : " " + String.Join(" ", args)),
                WorkingDirectory = folder,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (Process process = Process.Start(start)) { }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "轻量 Python 编辑器 · 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string FindPython(string preferred, string searchPath)
    {
        if (IsUsablePython(preferred)) return preferred;
        foreach (string directory in searchPath.Split(Path.PathSeparator))
        {
            if (String.IsNullOrWhiteSpace(directory)) continue;
            try
            {
                string candidate = Path.Combine(Environment.ExpandEnvironmentVariables(directory.Trim().Trim('"')), "python.exe");
                if (IsUsablePython(candidate)) return Path.GetFullPath(candidate);
            }
            catch (ArgumentException) { }
            catch (NotSupportedException) { }
        }
        return null;
    }

    private static bool IsUsablePython(string path)
    {
        try
        {
            // Windows' Store execution aliases are empty files, not Python interpreters.
            if (!File.Exists(path) || new FileInfo(path).Length == 0) return false;
            var start = new ProcessStartInfo
            {
                FileName = path,
                Arguments = "-I -c \"import sys, tkinter; sys.exit(0 if sys.version_info >= (3, 10) else 1)\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (Process probe = Process.Start(start))
            {
                if (probe == null) return false;
                if (!probe.WaitForExit(3000))
                {
                    probe.Kill();
                    probe.WaitForExit(1000);
                    return false;
                }
                return probe.ExitCode == 0;
            }
        }
        catch (System.ComponentModel.Win32Exception) { return false; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
        catch (InvalidOperationException) { return false; }
    }
}
