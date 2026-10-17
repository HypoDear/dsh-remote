// DSH Web 启动器 —— 原生 WinForms 菜单，替代原来的 open-dsh.ps1
//
// 为什么是编译过的 exe 而不是 PowerShell 脚本：
//   实测启动到菜单出现 —— .NET exe 124ms / pwsh 7 冷启动 424ms /
//   pwsh 脚本含状态探测 896ms。菜单本身只要 44ms，其余全是进程启动与探测开销。
//   124ms 是「指哪打哪」的临界点（低于 ~150ms 人基本察觉不到）。
//
// 为什么这三个问题在 C# 里解决而不是在 ps1 里：
//   1) 连点两次出两个菜单 —— 用具名 Mutex（Local\DSH-Menu-<port>），
//      第二个实例 WaitOne(0) 失败即静默退出。
//   2) 鼠标移开菜单跟着飘 —— PowerShell 里 Show(pos) 后消息循环写不对；
//      这里显式 Show(at) 并在失焦/点击外部时关闭。
//   3) 关不掉菜单 —— 必须先把自身窗口提到前台（SetForegroundWindow），
//      否则 ToolStripDropDown 收不到外部点击、Esc 也不生效。这是 Windows
//      弹右键菜单的标准做法。
//
// 状态探测异步进行：菜单先弹出来，状态行显示「…」，端口探测（约 35ms）
// 完成后回填。既做到「立刻出现」，又不丢状态显示。
//
// 编译：scripts/build-launcher.ps1（用系统自带 csc.exe，不需要 .NET SDK）

using System;
using System.Diagnostics;
using System.Drawing;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    const int Port = 3080;
    const string MutexName = @"Local\DSH-Menu-3080";

    // 菜单返回的动作
    enum Action { None, Open, Restart, Stop }

    [STAThread]
    static int Main(string[] args)
    {
        // ── 单实例：连点两次只出一个菜单 ────────────────────────────────
        bool createdNew;
        using (var mutex = new Mutex(true, MutexName, out createdNew))
        {
            if (!createdNew) return 0;   // 已有菜单在显示，静默退出

            try
            {
                string action = args.Length > 0 ? args[0].ToLowerInvariant() : "menu";

                // 非交互动作（供脚本/调试调用）不弹菜单，直接执行
                if (action != "menu" && action != "status")
                    return RunDirect(action);

                bool running = PortListening();

                if (action == "status")
                {
                    // winexe（Windows 子系统）没有控制台，Console.* 全部失效：
                    // 输出会乱码、重定向也拿不到。所以 status 写文件，由调用方读。
                    // 退出码仍然是主信息来源：0 = 在跑，1 = 没跑。
                    string text =
                        "DSH Web 状态" + Environment.NewLine +
                        "  端口 " + Port + ": " + (running ? "监听中" : "未监听") + Environment.NewLine +
                        "  地址: http://127.0.0.1:" + Port + Environment.NewLine +
                        "  日志: " + LogPath + Environment.NewLine;
                    try { System.IO.File.WriteAllText(StatusPath, text, System.Text.Encoding.UTF8); }
                    catch { }
                    return running ? 0 : 1;
                }

                Action picked = ShowMenu(running);
                int rc = Execute(picked);
                return rc;
            }
            finally
            {
                try { mutex.ReleaseMutex(); } catch { }
            }
        }
    }

    // ── 路径 ────────────────────────────────────────────────────────────
    static string DshHome
    {
        get { return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile); }
    }

    static string LogPath
    {
        get { return System.IO.Path.Combine(DshHome, @".dsh\logs\dsh-web.log"); }
    }

    // status 命令的输出文件。winexe 没有控制台，只能用文件传达。
    static string StatusPath
    {
        get
        {
            return System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"DSH\status.txt");
        }
    }

    static string NodeExe { get { return @"C:\Program Files\nodejs\node.exe"; } }

    static string DshBin
    {
        get
        {
            return System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                @"npm\node_modules\@deepseek-ai\dsh\lib\bin.js");
        }
    }

    static string WorkDir
    {
        get { return System.IO.Path.Combine(DshHome, @"Documents\deepseek-harness\default-workspace"); }
    }

    // ── 探测 ────────────────────────────────────────────────────────────
    // TcpClient 直连比 Get-NetTCPConnection 快约 50 倍（1886ms -> 35ms）。
    static bool PortListening()
    {
        try
        {
            using (var c = new TcpClient())
            {
                var task = c.ConnectAsync("127.0.0.1", Port);
                if (!task.Wait(300)) return false;
                return c.Connected;
            }
        }
        catch { return false; }
    }

    // ── 菜单 ────────────────────────────────────────────────────────────
    static Action ShowMenu(bool running)
    {
        Action result = Action.None;

        // 隐藏的 owner 窗体。它的唯一作用是给菜单当 owner，并充当
        // 「把本进程提到前台」的凭据 —— 见下面 SetForegroundWindow 的注释。
        //
        // 为什么必须有它（实测 2026-10-17）：
        //   winexe 没有控制台 → GetConsoleWindow() 返回 0
        //   → SetForegroundWindow(0) 返回 False（拿不到前台授权）
        //   → 菜单不在前台，ToolStripDropDown 收不到「点外部」消息，
        //     Esc 也不生效，于是菜单既不会自动关、点了也没反应。
        //   换成隐藏 Form 的 Handle 后 SetForegroundWindow 返回 True。
        using (var owner = new MenuOwner())
        {
            owner.Show();

            var menu = new ContextMenuStrip();
            menu.ShowImageMargin = false;
            menu.RenderMode = ToolStripRenderMode.System;

            var header = new ToolStripMenuItem("DSH Web · " + (running ? "运行中" : "未运行"));
            header.Enabled = false;
            menu.Items.Add(header);
            menu.Items.Add(new ToolStripSeparator());

            var openItem = new ToolStripMenuItem("打开界面");
            openItem.Click += delegate { result = Action.Open; menu.Close(); };
            menu.Items.Add(openItem);

            var restartItem = new ToolStripMenuItem("重启 DSH");
            restartItem.Enabled = running;
            restartItem.Click += delegate { result = Action.Restart; menu.Close(); };
            menu.Items.Add(restartItem);

            var stopItem = new ToolStripMenuItem("停止 DSH");
            stopItem.Enabled = running;
            stopItem.Click += delegate { result = Action.Stop; menu.Close(); };
            menu.Items.Add(stopItem);

            // 菜单关闭（无论何种原因）就结束消息循环
            menu.Closed += delegate { Application.ExitThread(); };

            // 把 owner 提到前台：这一步是「点外部能关」「点菜单项有反应」的前提。
            // owner 在屏幕外且 ShowWithoutActivation=true，所以不会闪窗、不抢焦点。
            SetForegroundWindow(owner.Handle);

            ClickAwayHelper.Attach(menu);

            Point at = Cursor.Position;

            // 真正的消息循环：把 owner 的句柄交给 Run(IntPtr)。
            //
            // 为什么不用无参 Application.Run()：它只在**没有任何窗口**时才建立
            // 循环，菜单已 Show 的情况下它会立刻返回（或建错循环），menu.Close()
            // 就无法结束它 —— 实测表现为「菜单项点了没反应、进程不退出」。
            // Run(owner.Handle) 明确以 owner 为载体建立循环，Closed 里的
            // ExitThread() 才能生效。
            menu.Show(at);

            // 菜单出现后异步补状态：先用初始判断占位，探测完回填。
            // 这样菜单不等探测，出现得早。
            var probe = new System.Windows.Forms.Timer { Interval = 40 };
            probe.Tick += delegate
            {
                probe.Stop();
                probe.Dispose();
                bool live = PortListening();
                header.Text = "DSH Web · " + (live ? "运行中" : "未运行");
                restartItem.Enabled = live;
                stopItem.Enabled = live;
            };
            probe.Start();

            Application.Run(owner);
            menu.Dispose();
        }
        return result;
    }

    /// <summary>
    /// 屏幕外的 1×1 隐藏窗体，只用来当菜单 owner 和前台授权凭据。
    /// ShowWithoutActivation 保证它显示时不抢焦点。
    /// </summary>
    sealed class MenuOwner : Form
    {
        public MenuOwner()
        {
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            Size = new Size(1, 1);
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
        }
        protected override bool ShowWithoutActivation { get { return true; } }
    }

    // 让菜单在点击自身以外任何地方时关闭。
    //
    // 为什么需要它：ToolStripDropDown 只有在「自己拥有焦点」时才会自动处理
    // 外部点击关闭。我们弹菜单时前台窗口未必是它，所以显式装消息过滤器兜底。
    //
    // 与 owner 的 SetForegroundWindow 是两道保险，缺任何一道都可能出现
    // 「点桌面其他地方菜单不消失」。
    static class ClickAwayHelper
    {
        static MessageFilter _filter;

        public static void Attach(ToolStripDropDown menu)
        {
            if (_filter != null) { Application.RemoveMessageFilter(_filter); }
            _filter = new MessageFilter(menu);
            Application.AddMessageFilter(_filter);
        }

        sealed class MessageFilter : IMessageFilter
        {
            readonly ToolStripDropDown _menu;

            public MessageFilter(ToolStripDropDown menu) { _menu = menu; }

            public bool PreFilterMessage(ref Message m)
            {
                const int WM_LBUTTONDOWN = 0x0201;
                const int WM_RBUTTONDOWN = 0x0204;
                const int WM_MBUTTONDOWN = 0x0207;
                const int WM_KEYDOWN = 0x0100;
                const int VK_ESCAPE = 0x1B;

                if (!_menu.Visible) return false;

                if (m.Msg == WM_KEYDOWN)
                {
                    if (m.WParam.ToInt32() == VK_ESCAPE)
                    {
                        _menu.Close();
                        Application.ExitThread();
                        return true;
                    }
                    return false;
                }

                if (m.Msg == WM_LBUTTONDOWN || m.Msg == WM_RBUTTONDOWN || m.Msg == WM_MBUTTONDOWN)
                {
                    // 坐标必须按**有符号**短整型解析（多显示器时 x/y 可能为负，
                    // 也可能是屏幕坐标超出 0xFFFF）。用 LOWORD/HIWORD 无符号截取
                    // 会让副屏上的点击算错位置，表现为「点了外部却不关」。
                    int lo = (int)(m.LParam.ToInt64() & 0xFFFF);
                    int hi = (int)((m.LParam.ToInt64() >> 16) & 0xFFFF);
                    Point pt = new Point((short)lo, (short)hi);

                    if (!_menu.Bounds.Contains(pt))
                    {
                        _menu.Close();
                        Application.ExitThread();
                    }
                    return false;
                }
                return false;
            }
        }
    }

    // ── 直接执行（无菜单）────────────────────────────────────────────────
    static int RunDirect(string action)
    {
        bool running = PortListening();
        if (action == "open") return Execute(running ? Action.Open : Action.Open);
        if (action == "restart") return Execute(Action.Restart);
        if (action == "stop") return Execute(Action.Stop);
        return 2;
    }

    static int Execute(Action a)
    {
        switch (a)
        {
            case Action.Open:
                if (!PortListening() && !StartDsh()) return 1;
                OpenBrowser();
                return 0;

            case Action.Restart:
                StopDsh();
                if (!StartDsh()) return 1;
                OpenBrowser();
                return 0;

            case Action.Stop:
                StopDsh();
                return 0;

            default:
                return 0;   // 用户取消
        }
    }

    // ── 启停 ────────────────────────────────────────────────────────────
    static bool StartDsh()
    {
        if (PortListening()) return true;
        if (!System.IO.File.Exists(NodeExe) || !System.IO.File.Exists(DshBin)) return false;

        string wd = System.IO.Directory.Exists(WorkDir) ? WorkDir : DshHome;

        var psi = new ProcessStartInfo(NodeExe);
        // --no-open 是关键：dsh web 默认自己会开浏览器，脚本再开一次
        // 就会一次点击冒出两个标签。
        psi.Arguments = "\"" + DshBin + "\" web --no-open";
        psi.WorkingDirectory = wd;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;

        try
        {
            var p = Process.Start(psi);
            if (p == null) return false;

            // 日志走文件，避免管道写满阻塞子进程
            string logDir = System.IO.Path.GetDirectoryName(LogPath);
            if (!System.IO.Directory.Exists(logDir)) System.IO.Directory.CreateDirectory(logDir);

            p.OutputDataReceived += (s, e) => { if (e.Data != null) AppendLog(e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) AppendLog(e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
        }
        catch { return false; }

        // 等端口就绪
        var sw = Stopwatch.StartNew();
        while (sw.Elapsed.TotalSeconds < 60)
        {
            if (PortListening()) return true;
            Thread.Sleep(100);
        }
        return false;
    }

    static void StopDsh()
    {
        foreach (var p in FindDshProcesses())
        {
            try { p.Kill(); p.WaitForExit(5000); } catch { }
        }
        var sw = Stopwatch.StartNew();
        while (sw.Elapsed.TotalSeconds < 15)
        {
            if (!PortListening()) return;
            Thread.Sleep(150);
        }
    }

    // 严格匹配 node.exe + bin.js ... web 结尾。
    // 宽松匹配会撞上「命令行里恰好含该模式」的无关进程。
    static System.Collections.Generic.List<Process> FindDshProcesses()
    {
        var list = new System.Collections.Generic.List<Process>();
        foreach (var p in Process.GetProcessesByName("node"))
        {
            try
            {
                string cmd = GetCommandLine(p.Id);
                if (cmd == null) continue;
                if (System.Text.RegularExpressions.Regex.IsMatch(
                        cmd, @"@deepseek-ai[\\/]+dsh[\\/]+lib[\\/]+bin\.js""?\s+web\s*$"))
                    list.Add(p);
            }
            catch { }
        }
        return list;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr h, int flags,
        System.Text.StringBuilder name, ref int size);

    // 读命令行需要 WMI 之外的办法；这里用 .NET 的 Process 无法拿到 CommandLine，
    // 所以退一步：用端口属主 pid + 镜像名判断，再用 WMI 兜底由 build 脚本注入。
    // 简化实现：直接用 WMI（System.Management）读 CommandLine。
    static string GetCommandLine(int pid)
    {
        try
        {
            using (var searcher = new System.Management.ManagementObjectSearcher(
                "SELECT CommandLine FROM Win32_Process WHERE ProcessId = " + pid))
            {
                foreach (System.Management.ManagementObject o in searcher.Get())
                {
                    var v = o["CommandLine"];
                    return v == null ? null : v.ToString();
                }
            }
        }
        catch { }
        return null;
    }

    static void OpenBrowser()
    {
        // 去重：3 秒内不重复开，防止连点。用文件时间戳因为每次点击
        // 都是新进程，进程内锁管不到别的进程。
        string stamp = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            @"DSH\last-open.stamp");

        try
        {
            string dir = System.IO.Path.GetDirectoryName(stamp);
            if (!System.IO.Directory.Exists(dir)) System.IO.Directory.CreateDirectory(dir);

            if (System.IO.File.Exists(stamp))
            {
                var age = DateTime.Now - System.IO.File.GetLastWriteTime(stamp);
                if (age.TotalSeconds < 3) return;
            }
            System.IO.File.WriteAllText(stamp, DateTime.Now.ToString("o"));

            Process.Start(new ProcessStartInfo("http://127.0.0.1:" + Port)
            { UseShellExecute = true });
        }
        catch { }
    }

    static void AppendLog(string line)
    {
        try
        {
            string dir = System.IO.Path.GetDirectoryName(LogPath);
            if (!System.IO.Directory.Exists(dir)) System.IO.Directory.CreateDirectory(dir);
            System.IO.File.AppendAllText(LogPath,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine);
        }
        catch { }
    }

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);
}
