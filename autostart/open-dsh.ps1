#Requires -Version 7.0
<#
  open-dsh.ps1 — 一键打开 DSH Web

  桌面快捷方式指向本脚本。行为：
    - 若 dsh web 已在运行  → 直接用默认浏览器打开 http://127.0.0.1:3080/
    - 若未在运行          → 先启动 dsh web，等它监听端口后，再打开浏览器

  这样即使自启任务没触发（或你手动关掉了 dsh），也永远不用回到终端敲命令。

  退出时不留窗口：调用方用 -WindowStyle Hidden 启动本脚本。
#>

[CmdletBinding()]
param(
    [int] $Port = 3080,

    # 等待 dsh 开始监听的最长秒数
    [int] $WaitSeconds = 90,

    [string] $LogPath
)

$ErrorActionPreference = 'Stop'

$NodeExe  = 'C:\Program Files\nodejs\node.exe'
$DshBin   = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$WorkDir  = Join-Path $env:USERPROFILE 'Documents\deepseek-harness\default-workspace'
$WebUrl   = "http://127.0.0.1:$Port/"

if (-not $LogPath) {
    $LogPath = Join-Path $env:USERPROFILE '.dsh\logs\dsh-web-open.log'
}
# 刻意与任务脚本的 dsh-web-autostart.log 分开：两条路径可能并发写同一实例的日志，
# 共用一个文件会交错。这里只是「由本脚本拉起」的实例的输出。
$StartLog = Join-Path $env:USERPROFILE '.dsh\logs\dsh-web-open-stdout.log'
$LogDir   = Split-Path -Parent $LogPath

function Write-Log {
    param([string] $Message)
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
        Add-Content -Path $LogPath -Value $line -Encoding utf8
    } catch { }
}

function Test-PortListening {
    param([int] $P)
    return [bool] (Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue)
}

# 严格正则，理由见 start-dsh-web.ps1 的 Get-DshWebProcess 注释。
function Get-DshWebProcess {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match '@deepseek-ai[\\/]+dsh[\\/]+lib[\\/]+bin\.js"?\s+web\s*$' }
}

# ── 1. 需要时先确保 dsh 在跑 ──────────────────────────────────────────────
if (-not (Test-PortListening -P $Port)) {
    # 与 start-dsh-web.ps1 共用同一把启动锁，避免两个启动器同时通过检查、
    # 各拉一个 dsh web。两个实例抢同一中继身份会刷出成片的
    # "Relay rejected the connection (KICKED)"。
    # 本脚本用 Start-Process 启动（不阻塞），所以锁只持有到端口就绪为止；
    # 计划任务那边是阻塞跑 dsh，锁会一直持有到 dsh 退出。
    $mutex = New-Object System.Threading.Mutex($false, "Local\DSH-Web-Launcher-$Port")
    $holdsMutex = $false
    try { $holdsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $holdsMutex = $true }

    try {
        if ($holdsMutex) {
            # 守卫一律在拿到锁之后判定，保证「判定 → 启动」之间没有别的启动器插入。
            if (@(Get-DshWebProcess).Count -eq 0) {
                Write-Log "dsh web 未运行，正在启动…"
                if (-not (Test-Path $WorkDir)) { $WorkDir = $env:USERPROFILE }
                Start-Process -FilePath $NodeExe `
                    -ArgumentList @("`"$DshBin`"", 'web') `
                    -WorkingDirectory $WorkDir `
                    -WindowStyle Hidden `
                    -RedirectStandardOutput $StartLog `
                    -RedirectStandardError "$StartLog.err" | Out-Null
            } else {
                Write-Log "检测到 dsh web 进程正在启动中，等待端口监听…"
            }
        } else {
            Write-Log "另一个启动器持有启动锁，等待端口监听…"
        }

        # 轮询等待端口出现
        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        while ((Get-Date) -lt $deadline) {
            if (Test-PortListening -P $Port) { break }
            Start-Sleep -Milliseconds 750
        }
    }
    finally {
        if ($holdsMutex) { try { $mutex.ReleaseMutex() } catch { } }
        $mutex.Dispose()
    }

    if (-not (Test-PortListening -P $Port)) {
        Write-Log "等待 $WaitSeconds 秒后端口 $Port 仍未监听，放弃打开浏览器。"
        exit 1
    }
    Write-Log "dsh web 已就绪。"
}

# ── 2. 打开浏览器 ─────────────────────────────────────────────────────────
# 用 rundll32 而非 cmd /c start：cmd 会把 URL 里的 & 当命令分隔符，截断链接。
try {
    Start-Process -FilePath 'rundll32.exe' `
        -ArgumentList @('url.dll,FileProtocolHandler', $WebUrl) `
        -WindowStyle Hidden
    Write-Log "已请求打开 $WebUrl"
    exit 0
}
catch {
    Write-Log "打开浏览器失败：$($_.Exception.Message)；请手动访问 $WebUrl"
    exit 1
}
