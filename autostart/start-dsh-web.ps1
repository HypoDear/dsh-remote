#Requires -Version 7.0
<#
  start-dsh-web.ps1 — DSH Web 的自启守卫与启动器

  由「任务计划程序」在用户登录时以隐藏窗口调用。也可手动运行。

  职责：
    1. 守卫：若 3080 端口已被监听、或已存在 dsh web 进程，则直接退出，不重复启动。
       （重复启动不会礼让：dsh 会因 EADDRINUSE 直接启动失败并退出。）
    2. 启动：以子进程方式运行 `dsh web`，并把全部输出追加到日志文件。
       本脚本会阻塞直到 dsh 退出，因此任务计划程序里该任务全程保持 Running，
       `MultipleInstances=IgnoreNew` 才真正起到防重复作用。
    3. 退出码：透传 dsh 的退出码，让任务计划程序的 RestartCount 能识别崩溃。

  注意：隐藏窗口由调用方负责（任务动作里传 -WindowStyle Hidden）。本脚本不再套
  Start-Process，正是为了让 node 成为本进程的子进程，从而（a）不继承已废弃的
  Start-Process 重定向参数组合，（b）保留进程父子关系便于排查。
#>

[CmdletBinding()]
param(
    # 监听端口，需与 dsh web 实际使用的端口一致
    [int] $Port = 3080,

    # 显式指定日志文件；默认落在 ~/.dsh/logs/dsh-web-autostart.log
    [string] $LogPath,

    # 日志超过该字节数即轮转一次（保留上一份为 .old）
    [long] $MaxLogBytes = 5MB,

    # 只做检查与打印，不真正启动 dsh（用于自检）
    [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'

# ── 固定路径（避免依赖 PATH / 当前目录）────────────────────────────────────
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$DshBin  = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$WorkDir = Join-Path $env:USERPROFILE 'Documents\deepseek-harness\default-workspace'

if (-not $LogPath) {
    $LogPath = Join-Path $env:USERPROFILE '.dsh\logs\dsh-web-autostart.log'
}
$LogDir = Split-Path -Parent $LogPath

# ── 小工具 ────────────────────────────────────────────────────────────────
function Write-Log {
    param([string] $Message)
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
        Add-Content -Path $LogPath -Value $line -Encoding utf8
    } catch { }
    Write-Host $line
}

function Invoke-LogRotation {
    try {
        if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -ge $MaxLogBytes) {
            Move-Item -Path $LogPath -Destination "$LogPath.old" -Force
        }
    } catch { }
}

# ── 守卫 1：端口是否已被监听 ──────────────────────────────────────────────
# 这是最贴近事实的判据：dsh web 起来后一定在监听该端口。
function Test-PortListening {
    param([int] $P)
    $conn = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue
    return [bool] $conn
}

# ── 守卫 2：是否已存在 dsh web 进程 ───────────────────────────────────────
# 正则刻意写得很严：必须以 bin.js" web 结尾，且只认 node 自身。
# 教训：宽松的 -like '*bin.js*web*' 会匹配到「命令行文本里恰好含有该模式」的
# 无关进程（例如 Agent 发起的查询命令自身），导致守卫误判「已有实例」而永不启动。
function Get-DshWebProcess {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match '@deepseek-ai[\\/]+dsh[\\/]+lib[\\/]+bin\.js"?\s+web\s*$' }
}

# ── 前置检查 ──────────────────────────────────────────────────────────────
foreach ($p in @($NodeExe, $DshBin)) {
    if (-not (Test-Path $p)) {
        Write-Log "FATAL  必需文件不存在：$p"
        exit 127
    }
}

Invoke-LogRotation

Write-Log '--- 自启检查开始 ---'

# ── 单实例启动锁 ──────────────────────────────────────────────────────────
# 下面两个守卫的「检查」与「启动」之间存在竞态窗口：两个启动器（本脚本的
# 计划任务 + open-dsh.ps1 的桌面快捷方式）可能同时通过检查，各自拉起一个
# dsh web。两个实例会抢同一个中继身份，表现为 diagnostics.jsonl 里成片的
# "Relay rejected the connection (KICKED)"。
# 具名互斥体把「检查 + 启动」闭合为原子操作。本脚本阻塞在 dsh 上，所以锁会
# 一直持有到 dsh 退出 —— 这就是硬单例；另一个启动器 0 超时直接让位。
# Local\ 前缀 = 同一登录会话内可见，正好覆盖「计划任务 + 桌面快捷方式」。
$mutex = New-Object System.Threading.Mutex($false, "Local\DSH-Web-Launcher-$Port")
$holdsMutex = $false

try {
    try { $holdsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $holdsMutex = $true }

    if (-not $holdsMutex) {
        Write-Log "SKIP   另一个启动器持有启动锁，判定已有实例正在启动，不重复启动。"
        exit 0
    }

    # 守卫一律在拿到锁之后判定，这样「判定」到「启动」之间没有别的启动器能插进来。
    $portBusy = Test-PortListening -P $Port
    $existing = @(Get-DshWebProcess)

    if ($portBusy) {
        $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                  Select-Object -First 1).OwningProcess
        Write-Log "SKIP   端口 $Port 已被 pid=$owner 监听，判定 dsh web 已在运行，不重复启动。"
        exit 0
    }

    if ($existing.Count -gt 0) {
        $ids = ($existing | ForEach-Object { $_.ProcessId }) -join ','
        Write-Log "SKIP   已存在 dsh web 进程 (pid=$ids) 但端口未监听；可能正在启动中，暂不介入。"
        exit 0
    }

    # ── 启动 ──────────────────────────────────────────────────────────────
    if ($WhatIf) {
        Write-Log "WHATIF 守卫通过，本应启动：$NodeExe `"$DshBin`" web  (cwd=$WorkDir)"
        exit 0
    }

    if (-not (Test-Path $WorkDir)) { $WorkDir = $env:USERPROFILE }

    Write-Log "START  启动 dsh web：node `"$DshBin`" web"
    Write-Log "       工作目录=$WorkDir   日志=$LogPath"

    $exitCode = 0
    try {
        Push-Location $WorkDir
        # 不用 Start-Process：让 node 成为子进程，脚本阻塞其生命周期。
        # 日志同时落文件；stdout/stderr 用红色/黄色已是 dsh 自己的事，这里全量捕获。
        & $NodeExe $DshBin web *>> $LogPath
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
    }
    catch {
        Write-Log "ERROR  dsh web 启动或运行异常：$($_.Exception.Message)"
        $exitCode = 1
    }
    finally {
        Pop-Location
    }

    Write-Log "EXIT   dsh web 已退出，退出码=$exitCode"
    exit $exitCode
}
finally {
    if ($holdsMutex) { try { $mutex.ReleaseMutex() } catch { } }
    $mutex.Dispose()
}
