#Requires -Version 7.0
<#
  open-dsh.ps1 — DSH Web 的启动 / 重启 / 停止入口（单快捷方式 + 弹出菜单）

  设计背景（为什么长这样）：

  早先的做法是「任务计划程序 + 守卫脚本 + 崩溃自动重拉」。那套东西的代价是
  一个常驻的 pwsh 守卫进程，以及围绕它的启动锁、RestartCount 等一堆机制。
  现在改成最小方式：**没有开机自启、没有崩溃重拉、没有常驻进程**，
  只有一个快捷方式，点一下弹菜单，选一项执行完就退出。

  为什么是「点一下弹菜单」而不是右键菜单：
  任务栏图标的右键永远属于 Windows 自己（「固定到任务栏 / 关闭窗口」），
  第三方无法接管。能做到右键菜单的只有系统托盘图标，但那需要一个常驻进程
  一直活着盯着 —— 与「最小方式」直接冲突。所以选左键弹菜单。

  动作语义：

    打开界面   dsh 在跑 → 直接开浏览器
               dsh 没跑 → 先启动，等端口就绪，再开浏览器
    重启 DSH   杀掉现有实例 → 等端口释放 → 启动 → 等就绪 → 开浏览器
    停止 DSH   杀掉现有实例 → 等端口释放（不开浏览器）

  关键实现点：

  1. 新实例用 Start-Process 启动，**不是**子进程阻塞式。脚本退出后 dsh 继续
     活着，因此本脚本不需要常驻，也就不需要任何托管机制。

  2. 进程识别用严格正则。教训：宽松的 '*bin.js*web*' 会匹配到「命令行文本里
     恰好含有该模式」的无关进程（例如 Agent 发起的查询命令自身），导致误判。

  3. 菜单需要 STA 线程。pwsh 默认就是 STA，无需额外处理。

  4. 本脚本含中文，必须存成 **UTF-8 with BOM**。无 BOM 时 Windows PowerShell
     5.1 会按 ANSI 解码，中文注释会撕碎后续代码；pwsh 7 虽能正确识别，
     但保持带 BOM 可让两个版本都能跑。

  用法：
    pwsh -File open-dsh.ps1                 弹出菜单（快捷方式用的就是这条）
    pwsh -File open-dsh.ps1 -Action open    不弹菜单，直接打开/启动
    pwsh -File open-dsh.ps1 -Action restart 直接重启
    pwsh -File open-dsh.ps1 -Action stop    直接停止
    pwsh -File open-dsh.ps1 -Action status  只打印状态（诊断用）
#>

[CmdletBinding()]
param(
    # 菜单是默认入口；其余动作便于脚本化调用与排查
    [ValidateSet('menu', 'open', 'restart', 'stop', 'status', 'install')]
    [string] $Action = 'menu',

    # 监听端口，需与 dsh web 实际使用的端口一致
    [int] $Port = 3080,

    # 动作完成后不要打开浏览器（脚本化调用时用）
    [switch] $NoBrowser,

    # 只打印将要做的事，不真正启停
    [switch] $WhatIf,

    # 仅 install 使用：快捷方式名称
    [string] $Name = 'DSH',

    # 仅 install 使用：放桌面 / 开始菜单 / 只生成图标
    [ValidateSet('Desktop', 'StartMenu', 'None')]
    [string] $Location = 'Desktop',

    # 仅 install 使用：强制重建图标
    [switch] $ForceIcon
)

$ErrorActionPreference = 'Stop'

# ── 第一时间抓住鼠标位置 ───────────────────────────────────────────────────
# 用户是「点了任务栏上的快捷方式」触发的，进程刚起来的这一瞬间鼠标就停在点击处。
# 后面查进程/端口（Get-CimInstance 要 1-3 秒）会让鼠标有机会移开，那时再读
# Cursor.Position，菜单就会弹到「桌面很远的地方」。所以必须在最开头就抓。
$script:LaunchCursor = $null
try {
    Add-Type -AssemblyName System.Windows.Forms
    $cp = [System.Windows.Forms.Cursor]::Position
    $script:LaunchCursor = New-Object System.Drawing.Point($cp.X, $cp.Y)
}
catch { /* 抓不到就退回弹出时再读 */ }

# ── 固定路径（不依赖 PATH / 当前目录）──────────────────────────────────────
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$DshBin  = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$WorkDir = Join-Path $env:USERPROFILE 'Documents\deepseek-harness\default-workspace'
$LogPath = Join-Path $env:USERPROFILE '.dsh\logs\dsh-web.log'
$Url     = "http://127.0.0.1:$Port"

# 启动后等端口就绪的上限；dsh 冷启动通常在 3-8 秒
$StartTimeoutSec = 60
# 停止后等端口释放的上限
$StopTimeoutSec  = 15

# ── 小工具 ─────────────────────────────────────────────────────────────────
function Write-Log {
    param([string] $Message)
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try {
        $dir = Split-Path -Parent $LogPath
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        # 简单轮转：超过 2MB 就换一份 .old，避免日志无限长大
        if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -ge 2MB) {
            Move-Item -Path $LogPath -Destination "$LogPath.old" -Force
        }
        Add-Content -Path $LogPath -Value $line -Encoding utf8
    } catch { }
}

function Show-ErrorBox {
    param([string] $Message)
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(
        $Message, 'DSH', 'OK', 'Warning')
}

# ── 状态探测 ───────────────────────────────────────────────────────────────
# 性能要点（实测数据，决定实现方式）：
#   Get-NetTCPConnection   ~1886 ms   ← 原实现，菜单卡顿的主因
#   TcpClient 连本机端口      ~35 ms   ← 快 50 倍
#   Get-CimInstance 全量     ~190 ms
#   Get-Process -Name node    ~15 ms
# 所以端口用 TcpClient 直连探测，进程用 Get-Process 快速筛。

# 严格正则：只认 node.exe，且命令行必须以 bin.js" web 结尾。
# 教训：宽松的 '*bin.js*web*' 会匹配到「命令行里恰好含有该模式」的无关进程
# （例如 Agent 发起的查询命令自身），导致误判「已有实例」而永不启动。
$DshCmdPattern = '@deepseek-ai[\\/]+dsh[\\/]+lib[\\/]+bin\.js"?\s+web\s*$'

function Get-DshProcess {
    # 先用 Get-Process 按名字快速筛掉绝大多数进程（15ms），
    # 再只对 node 进程查命令行（CIM 的昂贵部分就只覆盖少数几个进程）。
    $nodes = @(Get-Process -Name node -ErrorAction SilentlyContinue)
    if ($nodes.Count -eq 0) { return @() }
    $ids = ($nodes | ForEach-Object { $_.Id }) -join ','
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $ids -split ',' -contains "$($_.ProcessId)" -and $_.CommandLine -match $DshCmdPattern }
}

function Test-PortListening {
    # TcpClient 直连：比 Get-NetTCPConnection 快约 50 倍，且只回答「能不能连上」
    # 这个我们真正关心的问题。300ms 超时足够本机回环。
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $task.Wait(300)) { return $false }
        return $client.Connected
    }
    catch { return $false }
    finally { try { $client.Close() } catch { } }
}

function Get-PortOwnerPid {
    # 只有需要显示 pid 时才查（netstat 比 Get-NetTCPConnection 快得多）
    try {
        $line = netstat -ano -p TCP | Select-String ":$Port\s" | Select-String 'LISTENING' | Select-Object -First 1
        if ($line -and $line.Line -match 'LISTENING\s+(\d+)') { return [int]$Matches[1] }
    } catch { }
    return $null
}

function Get-DshState {
    param([switch] $WithOwner)

    $portBusy = Test-PortListening
    $procs = @(Get-DshProcess)

    # 已经连得上就不必再查进程：端口在听就是最直接的事实。
    # 只有「端口没通」时才需要知道是否有进程正在启动途中。
    $ownerPid = $null
    if ($portBusy -and $WithOwner) { $ownerPid = Get-PortOwnerPid }

    [pscustomobject]@{
        Running  = ($procs.Count -gt 0) -or $portBusy
        Pids     = @($procs | ForEach-Object { $_.ProcessId })
        PortBusy = $portBusy
        OwnerPid = $ownerPid
        Ready    = $portBusy      # 端口在听 = 真的能用了
    }
}

function Format-DshState {
    param($State)
    if ($State.Ready) {
        $who = if ($State.Pids.Count) { $State.Pids -join ',' } else { $State.OwnerPid }
        return "运行中 · pid $who"
    }
    if ($State.Running) { return '启动中…' }
    return '未运行'
}

# ── 启动 / 停止 ────────────────────────────────────────────────────────────
function Start-Dsh {
    param($State)

    if ($State.Ready) { Write-Log 'SKIP   已在运行，无需启动。'; return $true }

    foreach ($p in @($NodeExe, $DshBin)) {
        if (-not (Test-Path $p)) {
            Show-ErrorBox "缺少必需文件：`n$p"
            Write-Log "FATAL  必需文件不存在：$p"
            return $false
        }
    }

    if ($WhatIf) { Write-Log "WHATIF 将启动：$NodeExe `"$DshBin`" web  (cwd=$WorkDir)"; return $true }

    $wd = if (Test-Path $WorkDir) { $WorkDir } else { $env:USERPROFILE }
    Write-Log "START  启动 dsh web（工作目录=$wd）"

    try {
        # Start-Process：新实例与脚本脱钩，脚本退出后它继续活着。
        # 日志走文件，避免继承一个隐藏控制台后无处可写。
        #
        # 必须带 --no-open：dsh web 默认自己会打开浏览器（日志里的
        # "dsh web: opening the default browser"）。我们在端口就绪后自己开
        # 一次，两边都开就冒出两个标签页 —— 这正是「容易打开多个浏览器标签」
        # 的根因，光靠脚本侧去重治不了。
        $null = Start-Process -FilePath $NodeExe `
            -ArgumentList @($DshBin, 'web', '--no-open') `
            -WorkingDirectory $wd `
            -WindowStyle Hidden `
            -RedirectStandardOutput $LogPath `
            -RedirectStandardError "$LogPath.err" `
            -PassThru
    }
    catch {
        Write-Log "ERROR  启动失败：$($_.Exception.Message)"
        Show-ErrorBox "启动 dsh web 失败：`n$($_.Exception.Message)`n`n日志：$LogPath"
        return $false
    }

    # 等端口就绪。轮询间隔改小（100ms），因为 Test-PortListening 现在只要 ~35ms，
    # 比原来每次 1.9 秒的 Get-NetTCPConnection 快得多，密集轮询才划算。
    $deadline = (Get-Date).AddSeconds($StartTimeoutSec)
    $missCount = 0
    while ((Get-Date) -lt $deadline) {
        if (Test-PortListening) {
            Write-Log "OK     端口 $Port 已就绪。"
            return $true
        }
        # 连续 3 次（约 0.3s）既连不上、也找不到进程 -> 判定启动即失败。
        # 用计数而不是单次判断，避免 dsh 冷启动初期的瞬时窗口误判。
        if (-not (Test-PortListening) -and @(Get-DshProcess).Count -eq 0) {
            $missCount++
            if ($missCount -ge 3) {
                Write-Log 'ERROR  进程启动后立即退出，详见日志。'
                Show-ErrorBox "dsh web 启动后立即退出。`n`n日志：$LogPath"
                return $false
            }
        }
        else { $missCount = 0 }
        Start-Sleep -Milliseconds 100
    }

    Write-Log "ERROR  ${StartTimeoutSec}s 内端口未就绪。"
    Show-ErrorBox "dsh web 在 ${StartTimeoutSec} 秒内没有就绪。`n`n日志：$LogPath"
    return $false
}

function Stop-Dsh {
    param($State)

    if (-not $State.Running) { Write-Log 'SKIP   本来就没在运行。'; return $true }

    if ($WhatIf) { Write-Log "WHATIF 将停止 pid $($State.Pids -join ',')"; return $true }

    $targets = @($State.Pids)
    if ($targets.Count -eq 0 -and $State.OwnerPid) { $targets = @($State.OwnerPid) }

    foreach ($id in $targets) {
        try { Stop-Process -Id $id -Force -ErrorAction Stop; Write-Log "STOP   已结束 pid=$id" }
        catch { Write-Log "WARN  结束 pid=$id 失败：$($_.Exception.Message)" }
    }

    # 等端口释放（重启时立刻再启会撞 EADDRINUSE，所以必须等干净）
    $deadline = (Get-Date).AddSeconds($StopTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-PortListening) -and @(Get-DshProcess).Count -eq 0) {
            Write-Log 'OK     已停止，端口已释放。'
            return $true
        }
        Start-Sleep -Milliseconds 200
    }

    Write-Log "WARN  ${StopTimeoutSec}s 内未完全停止。"
    return $false
}

function Focus-ExistingTab {
    <#
      在已打开的浏览器标签里找 DSH 页面，找到就把窗口还原并置前。

      为什么用 UI Automation：
        浏览器的窗口标题只显示**当前活动标签**（实测：8 个标签时标题是
        "OMEGA 和另外 7 个页面"），靠 MainWindowTitle 抓不到后台标签。
        UI Automation 能遍历到 TabItem 级别的子元素，拿到每个标签的真实标题。
        实测 96ms 拿到全部 8 个标签。

      识别依据：标签标题含 "DeepSeek Harness"（DSH 前端的 <title>）。
        已知取舍：若将来同时跑多个 DSH 实例，会被认成同一个。当前只跑一个实例。

      找不到浏览器 / 没装 UIA 时返回 $false，让调用方照常开新标签 —— 
      这个功能是锦上添花，任何失败都不该挡住「打开界面」。

      返回 $true 表示「已切到现有标签，不要开新的」。
    #>
    param([string] $TitlePattern = 'DeepSeek Harness')

    try {
        Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
        Add-Type -AssemblyName UIAutomationTypes  -ErrorAction Stop

        $AE   = [System.Windows.Automation.AutomationElement]
        $root = $AE::RootElement

        # 浏览器顶层窗口的类名（Chromium 系共用 Chrome_WidgetWin_1）
        $winCond = New-Object System.Windows.Automation.PropertyCondition(
            $AE::ClassNameProperty, 'Chrome_WidgetWin_1')
        $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
        if ($windows.Count -eq 0) { return $false }

        $tabCond = New-Object System.Windows.Automation.PropertyCondition(
            $AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)

        foreach ($win in $windows) {
            $tabs = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
            foreach ($tab in $tabs) {
                if ($tab.Current.Name -notmatch [regex]::Escape($TitlePattern)) { continue }

                # 命中：先把该标签设为活动标签，再还原+置前整窗。
                try {
                    $sel = $tab.GetCurrentPattern(
                        [System.Windows.Automation.SelectionItemPattern]::Pattern)
                    $sel.Select()
                }
                catch {
                    # 有的 Chromium 版本不给 TabItem 暴露 SelectionItem。
                    # 退而求其次：只把整个窗口置前（活动标签可能不是 DSH）。
                    # 不视为失败——窗口切过去后用户自己点一下标签即可。
                    Write-Log "INFO   无法直接选中标签（$($_.Exception.Message)），只切窗口。"
                }

                try {
                    $hwnd = [IntPtr]$win.Current.NativeWindowHandle
                    if ($hwnd -ne [IntPtr]::Zero) {
                        if ([Win32]::IsIconic($hwnd)) { [void][Win32]::ShowWindow($hwnd, 9) }  # SW_RESTORE
                        [void][Win32]::SetForegroundWindow($hwnd)
                    }
                }
                catch { Write-Log "INFO   切窗口失败：$($_.Exception.Message)" }

                Write-Log "FOCUS  已切到现有标签：$($tab.Current.Name)"
                return $true
            }
        }
        return $false
    }
    catch {
        # UIA 不可用（未安装 / 权限 / 浏览器不支持）时静默降级
        Write-Log "INFO   标签探测不可用，改为直接打开：$($_.Exception.Message)"
        return $false
    }
}

# 置前/还原窗口需要的 Win32 调用。类型只注册一次。
if (-not ('Win32' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@ -ErrorAction SilentlyContinue
}

function Open-Browser {
    if ($NoBrowser) { Write-Log 'SKIP   按参数不打开浏览器。'; return }
    if ($WhatIf) { Write-Log "WHATIF 将打开 $Url"; return }

    # ① 先去已有标签页里找：已经开着就切过去，绝不再开一个。
    #    这是「明明已经开着一个标签，再点打开又冒出一个」的直接解法。
    if (Focus-ExistingTab) { return }

    # ② 没找到才开新的。附带一个 3 秒去重标记：连点或重复触发时不再叠加，
    #    因为每次点击都是新的 pwsh 进程，进程内锁管不到别的进程，
    #    只能用跨进程的文件时间戳。
    $stamp = Join-Path $env:LOCALAPPDATA 'DSH\last-open.stamp'
    try {
        $dir = Split-Path -Parent $stamp
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

        if (Test-Path $stamp) {
            $age = (Get-Date) - (Get-Item $stamp).LastWriteTime
            if ($age.TotalSeconds -lt 3) {
                Write-Log "SKIP   ${Url} 刚在 $([int]$age.TotalMilliseconds)ms 前打开过，跳过重复打开。"
                return
            }
        }
        Set-Content -Path $stamp -Value (Get-Date -Format o) -Encoding utf8

        Start-Process $Url
        Write-Log "OPEN   $Url"
    }
    catch { Write-Log "WARN  打开浏览器失败：$($_.Exception.Message)" }
}

# ── 菜单 ───────────────────────────────────────────────────────────────────
# 返回 'open' / 'restart' / 'stop' / $null（用户点了别处或按 Esc）
function Show-DshMenu {
    param($State)

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $menu.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $menu.ShowImageMargin = $false
    $menu.RenderMode = 'System'

    # 状态行：禁用项，只用来显示当前状态
    $hdr = New-Object System.Windows.Forms.ToolStripMenuItem("DSH Web · $(Format-DshState $State)")
    $hdr.Enabled = $false
    [void]$menu.Items.Add($hdr)
    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

    $script:menuPicked = $null

    $add = {
        param([string] $text, [string] $tag, [bool] $enabled = $true)
        $it = New-Object System.Windows.Forms.ToolStripMenuItem($text)
        $it.Tag = $tag
        $it.Enabled = $enabled
        $it.add_Click({
            param($sender, $e)
            $script:menuPicked = $sender.Tag
            [System.Windows.Forms.Application]::ExitThread()
        })
        [void]$menu.Items.Add($it)
    }

    & $add '打开界面' 'open' $true
    & $add '重启 DSH' 'restart' $State.Running
    & $add '停止 DSH' 'stop'    $State.Running

    # 用户点别处 / 按 Esc 关闭时也要退出消息循环
    $menu.add_Closed({
        if ($null -eq $script:menuPicked) { [System.Windows.Forms.Application]::ExitThread() }
    })

    # 在「点击时的鼠标位置」弹出，并做屏幕内钳制（任务栏在底部时要向上翻）。
    # 用启动瞬间抓到的坐标，而不是现在的 Cursor.Position —— 见文件开头那段注释。
    $anchor = if ($null -ne $script:LaunchCursor) { $script:LaunchCursor } else { [System.Windows.Forms.Cursor]::Position }
    $pos = New-Object System.Drawing.Point($anchor.X, $anchor.Y)
    $wa  = [System.Windows.Forms.Screen]::FromPoint($pos).WorkingArea
    $sz  = $menu.GetPreferredSize([System.Drawing.Size]::Empty)
    if ($pos.X + $sz.Width  -gt $wa.Right)  { $pos.X = $wa.Right  - $sz.Width }
    if ($pos.Y + $sz.Height -gt $wa.Bottom) { $pos.Y = $wa.Bottom - $sz.Height }
    if ($pos.X -lt $wa.Left) { $pos.X = $wa.Left }
    if ($pos.Y -lt $wa.Top)  { $pos.Y = $wa.Top }

    $menu.Show($pos)
    [System.Windows.Forms.Application]::Run()
    $menu.Dispose()

    return $script:menuPicked
}

# ── install：生成图标 + 创建快捷方式 ───────────────────────────────────────
<#
  把原来单独的 create-shortcut.ps1 并进来，仓库里只留这一个脚本。

  图标不在仓库里放 .ico 二进制。运行时从 DSH 自带的 favicon.svg 生成
  dsh.ico，存到 %LOCALAPPDATA%\DSH\（用户目录，不是仓库）。
  favicon 找不到时退回 PowerShell 自身图标 —— 图标只是外观，不该阻塞功能。

  为什么图标要生成而不是内嵌：
  .lnk 的 IconLocation 只接受文件路径，不支持内嵌图像。所以要么带一个 .ico
  文件，要么运行时造一个。选后者，仓库里就只有脚本。
#>
function New-DshIcon {
    param([string] $OutPath)

    $favicon = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-web-frontend\dist\favicon.svg'
    if (-not (Test-Path $favicon)) {
        Write-Host '  提示：找不到 favicon.svg，图标改用 PowerShell 默认。' -ForegroundColor Yellow
        return $false
    }

    # 需要一个浏览器把 SVG 光栅化。Edge 在 Windows 上恒在。
    $edge = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $edge) {
        Write-Host '  提示：找不到 Edge，无法光栅化 SVG，图标改用默认。' -ForegroundColor Yellow
        return $false
    }

    $tmp = Join-Path $env:TEMP "dsh-icon-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        # SVG 原生只有 50x50，必须先用 HTML 撑到 512，否则鲸鱼只占画布一角。
        $html = @"
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:512px;height:512px;background:transparent;overflow:hidden}
img{display:block;width:512px;height:512px}
</style></head><body><img src="file:///$($favicon -replace '\\','/')"></body></html>
"@
        $htmlPath = Join-Path $tmp 'render.html'
        Set-Content -Path $htmlPath -Value $html -Encoding UTF8

        $bigPng = Join-Path $tmp 'whale-512.png'
        & $edge --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 `
            --default-background-color=00000000 --window-size=512,512 --virtual-time-budget=3000 `
            --screenshot="$bigPng" "file:///$($htmlPath -replace '\\','/')" 2>&1 | Out-Null
        Start-Sleep -Milliseconds 1200
        if (-not (Test-Path $bigPng)) {
            Write-Host '  提示：图标渲染失败，改用默认。' -ForegroundColor Yellow
            return $false
        }

        Add-Type -AssemblyName System.Drawing
        $src = [System.Drawing.Bitmap]::FromFile($bigPng)
        try {
            # 裁掉透明留白
            $minX = $src.Width; $minY = $src.Height; $maxX = -1; $maxY = -1
            for ($y = 0; $y -lt $src.Height; $y++) {
                for ($x = 0; $x -lt $src.Width; $x++) {
                    if ($src.GetPixel($x, $y).A -gt 8) {
                        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
                        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
                    }
                }
            }
            if ($maxX -lt 0) { Write-Host '  提示：图标全透明，改用默认。' -ForegroundColor Yellow; return $false }

            $pad = 8
            $minX = [Math]::Max(0, $minX - $pad); $minY = [Math]::Max(0, $minY - $pad)
            $maxX = [Math]::Min($src.Width - 1, $maxX + $pad); $maxY = [Math]::Min($src.Height - 1, $maxY + $pad)
            $cw = $maxX - $minX + 1; $ch = $maxY - $minY + 1
            $crop = New-Object System.Drawing.Rectangle($minX, $minY, $cw, $ch)

            $sizes = @(16, 24, 32, 48, 64, 128, 256)
            $entries = @()
            foreach ($s in $sizes) {
                $b = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
                $g = [System.Drawing.Graphics]::FromImage($b)
                $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                $g.Clear([System.Drawing.Color]::Transparent)
                $scale = [Math]::Min($s / $cw, $s / $ch)
                $dw = [Math]::Max(1, [int]($cw * $scale)); $dh = [Math]::Max(1, [int]($ch * $scale))
                $dx = [int](($s - $dw) / 2); $dy = [int](($s - $dh) / 2)
                $g.DrawImage($src, (New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)), $crop,
                    [System.Drawing.GraphicsUnit]::Pixel)
                $g.Dispose()

                if ($s -ge 256) {
                    # 256x256 用 PNG（唯一被广泛支持的 PNG-in-ICO 尺寸）
                    $ms = New-Object System.IO.MemoryStream
                    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                    $entries += , @($s, $ms.ToArray())
                    $ms.Dispose()
                }
                else {
                    # 其余必须是 BMP(DIB)：Explorer 为任务栏/桌面取小图标时只走
                    # BMP 解码路径，PNG 条目在那些尺寸下会渲染成**空白图标**。
                    $ms = New-Object System.IO.MemoryStream
                    $bw2 = New-Object System.IO.BinaryWriter($ms)
                    $bw2.Write([UInt32]40)                 # biSize
                    $bw2.Write([Int32]$s)                  # biWidth
                    $bw2.Write([Int32]($s * 2))            # biHeight（含 AND 掩码，所以 x2）
                    $bw2.Write([UInt16]1)                  # biPlanes
                    $bw2.Write([UInt16]32)                 # biBitCount
                    $bw2.Write([UInt32]0)                  # biCompression = BI_RGB
                    $bw2.Write([UInt32]($s * $s * 4))      # biSizeImage
                    $bw2.Write([Int32]0); $bw2.Write([Int32]0)
                    $bw2.Write([UInt32]0); $bw2.Write([UInt32]0)
                    # 像素：BMP 是 bottom-up 的 BGRA
                    for ($y = $s - 1; $y -ge 0; $y--) {
                        for ($x = 0; $x -lt $s; $x++) {
                            $c = $b.GetPixel($x, $y)
                            $bw2.Write([byte]$c.B); $bw2.Write([byte]$c.G)
                            $bw2.Write([byte]$c.R); $bw2.Write([byte]$c.A)
                        }
                    }
                    # AND 掩码：每行按 4 字节对齐，1bit/像素（0=不透明）
                    $maskRow = [Math]::Ceiling($s / 32.0) * 4
                    for ($y = $s - 1; $y -ge 0; $y--) {
                        $row = New-Object byte[] $maskRow
                        for ($x = 0; $x -lt $s; $x++) {
                            if ($b.GetPixel($x, $y).A -eq 0) {
                                $row[[Math]::Floor($x / 8)] = $row[[Math]::Floor($x / 8)] -bor (1 -shl (7 - ($x % 8)))
                            }
                        }
                        $bw2.Write($row)
                    }
                    $bw2.Flush()
                    $entries += , @($s, $ms.ToArray())
                    $bw2.Dispose(); $ms.Dispose()
                }
                $b.Dispose()
            }

            $fs = [System.IO.File]::Create($OutPath)
            $bw = New-Object System.IO.BinaryWriter($fs)
            $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$entries.Count)
            $offset = 6 + 16 * $entries.Count
            foreach ($e in $entries) {
                $dim = if ($e[0] -ge 256) { 0 } else { $e[0] }
                $bw.Write([byte]$dim); $bw.Write([byte]$dim)
                $bw.Write([byte]0); $bw.Write([byte]0)
                $bw.Write([UInt16]1); $bw.Write([UInt16]32)
                $bw.Write([UInt32]$e[1].Length); $bw.Write([UInt32]$offset)
                $offset += $e[1].Length
            }
            foreach ($e in $entries) { $bw.Write($e[1]) }
            $bw.Flush(); $bw.Dispose(); $fs.Dispose()
        }
        finally { $src.Dispose() }
    }
    finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    return $true
}

function Invoke-Install {
    $scriptPath = $PSCommandPath
    if (-not $scriptPath) { $scriptPath = Join-Path $PSScriptRoot 'open-dsh.ps1' }

    $iconDir  = Join-Path $env:LOCALAPPDATA 'DSH'
    $iconPath = Join-Path $iconDir 'dsh.ico'
    New-Item -ItemType Directory -Path $iconDir -Force | Out-Null

    if ($ForceIcon -or -not (Test-Path $iconPath)) {
        Write-Host '生成图标…'
        if (New-DshIcon -OutPath $iconPath) {
            Write-Host "  已生成：$iconPath" -ForegroundColor Green
        }
    }
    else {
        Write-Host "图标已存在：$iconPath（加 -ForceIcon 可重建）"
    }

    if ($Location -eq 'None') {
        Write-Host ''
        Write-Host "按参数只准备图标，未创建快捷方式。"
        Write-Host "图标路径：$iconPath"
        return
    }

    $pwshExe = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $targetDir = if ($Location -eq 'Desktop') {
        [Environment]::GetFolderPath('Desktop')
    } else {
        Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    }
    $lnkPath = Join-Path $targetDir "$Name.lnk"

    # WScript.Shell 建 .lnk（本机 VBScript 引擎已移除，但该 COM 组件仍在）
    $shell = New-Object -ComObject WScript.Shell
    try {
        $lnk = $shell.CreateShortcut($lnkPath)
        $lnk.TargetPath       = $pwshExe
        $lnk.Arguments        = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $scriptPath
        $lnk.WorkingDirectory = $PSScriptRoot
        $lnk.Description      = 'DSH Web：点一下弹出菜单（打开界面 / 重启 / 停止）'
        $lnk.WindowStyle      = 7      # 最小化，配合 -WindowStyle Hidden 把控制台闪现降到最低
        $lnk.IconLocation     = if (Test-Path $iconPath) { "$iconPath,0" } else { "$pwshExe,0" }
        $lnk.Save()
    }
    finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }

    $check = (New-Object -ComObject WScript.Shell).CreateShortcut($lnkPath)
    Write-Host ''
    Write-Host "已创建：$lnkPath" -ForegroundColor Green
    Write-Host "  目标     : $($check.TargetPath)"
    Write-Host "  参数     : $($check.Arguments)"
    Write-Host "  起始位置 : $($check.WorkingDirectory)"
    Write-Host "  图标     : $($check.IconLocation)"
    Write-Host ''
    Write-Host '固定到任务栏：右键该快捷方式 → 显示更多选项 → 固定到任务栏'
    Write-Host '（Win11 也可以直接把它拖到任务栏上。）'
}

# ── 主流程 ─────────────────────────────────────────────────────────────────
try {
    # install 完全不关心 dsh 是否在跑，先处理掉，省一次状态探测。
    if ($Action -eq 'install') {
        Invoke-Install
        exit 0
    }

    # 只有 status 需要显示端口属主 pid —— 那是给人看的诊断信息。
    # 菜单/启停路径不需要它，省掉一次 netstat（~200ms）。
    $state = Get-DshState -WithOwner:($Action -eq 'status')

    if ($Action -eq 'status') {
        Write-Host "DSH Web 状态"
        Write-Host "  状态    : $(Format-DshState $state)"
        Write-Host "  进程    : $(if ($state.Pids.Count) { $state.Pids -join ',' } else { '（无）' })"
        Write-Host "  端口    : $Port $(if ($state.PortBusy) { "监听中 (pid $($state.OwnerPid))" } else { '未监听' })"
        Write-Host "  地址    : $Url"
        Write-Host "  日志    : $LogPath"
        exit 0
    }

    if ($Action -eq 'menu') {
        # 注意：$Action 是 [ValidateSet] 参数，赋 $null 会触发验证错误
        # （"该值 不是变量 Action 的有效值"）。所以取消时直接退出，
        # 绝不把 $null 回写给 $Action。
        $picked = Show-DshMenu -State $state
        if ($null -eq $picked -or "$picked" -eq '') { exit 0 }   # 用户取消
        Write-Log "MENU   选择：$picked"
        $Action = "$picked"

        # 不在这里重新探测状态：open/restart/stop 三个分支各自会
        # 按需重新判断（stop 用旧状态即可，restart 会自己再探一次）。
        # 从前这里无条件 Get-DshState，等于白花一次探测的钱。
    }

    switch ($Action) {
        'open' {
            if (-not $state.Ready) {
                if (-not (Start-Dsh -State $state)) { exit 1 }
            }
            Open-Browser
        }
        'restart' {
            if (-not (Stop-Dsh -State $state)) { exit 1 }
            $fresh = Get-DshState
            if (-not (Start-Dsh -State $fresh)) { exit 1 }
            Open-Browser
        }
        'stop' {
            if (-not (Stop-Dsh -State $state)) { exit 1 }
        }
    }

    exit 0
}
catch {
    Write-Log "FATAL  $($_.Exception.Message)"
    Show-ErrorBox "操作失败：`n$($_.Exception.Message)`n`n日志：$LogPath"
    exit 1
}
