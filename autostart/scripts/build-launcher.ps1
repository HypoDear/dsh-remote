#Requires -Version 7.0
<#
  build-launcher.ps1 — 把 DshLauncher.cs 编译成 DshLauncher.exe

  用系统自带的 csc.exe（.NET Framework 4.x），不需要装 .NET SDK。
  产物是个 4-5 KB 的原生 WinForms exe，启动到菜单出现约 124ms
  （对比 pwsh 脚本 896ms）。

  产物不入库（.gitignore 已排除 *.exe），需要时现场编译即可。
#>

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $PSScriptRoot    # 仓库根（本脚本在 scripts/ 下）
$src  = Join-Path $here 'DshLauncher.cs'
$exe  = Join-Path $here 'DshLauncher.exe'

if (-not (Test-Path $src)) { throw "找不到源码：$src" }

# 找 csc.exe（32/64 位 framework 路径都可能）
$csc = @(
    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $csc) {
    throw '找不到 csc.exe。需要 .NET Framework 4.x（Windows 自带）。'
}
Write-Host "使用编译器：$csc"

# 必须用 /target:winexe，不能用 /target:exe。
# /target:exe 是**控制台**子系统（PE Subsystem=3），每次运行都分配一个黑色
# 控制台窗口 —— 用户看到的就是「点一下弹出两个窗口」。
# /target:winexe 是 Windows GUI 子系统（Subsystem=2），没有控制台。
# 代价：winexe 下 Console.* 全部失效（输出乱码、重定向也拿不到），
# 所以 status 改成写 %LOCALAPPDATA%\DSH\status.txt，靠退出码传达状态。
& $csc /nologo /target:winexe /platform:anycpu /optimize+ `
    /out:$exe `
    /r:System.Windows.Forms.dll `
    /r:System.Drawing.dll `
    /r:System.Management.dll `
    $src

if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }
if (-not (Test-Path $exe)) { throw '编译没有产出 exe' }

$size = (Get-Item $exe).Length
Write-Host "已生成：$exe  ($size bytes)" -ForegroundColor Green

# 验证子系统真的是 2（Windows GUI）—— 这是「不弹控制台窗口」的判据
$bytes = [System.IO.File]::ReadAllBytes($exe)
$peOff = [BitConverter]::ToInt32($bytes, 0x3C)
$subsystem = [BitConverter]::ToUInt16($bytes, $peOff + 0x5C)
Write-Host "PE Subsystem = $subsystem  $(if ($subsystem -eq 2) { '(Windows GUI，无控制台)' } else { '(!! 控制台子系统，会弹黑窗)' })"
if ($subsystem -ne 2) { throw "Subsystem 应为 2，实得 $subsystem" }

# 冒烟测试：跑 status，读它的输出文件
$statusFile = Join-Path $env:LOCALAPPDATA 'DSH\status.txt'
Remove-Item $statusFile -Force -ErrorAction SilentlyContinue
& $exe status | Out-Null
$code = $LASTEXITCODE

Write-Host ''
Write-Host 'status 冒烟测试：'
if (Test-Path $statusFile) {
    Get-Content $statusFile -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
}
else { Write-Host '  !! 没有生成 status.txt' ; throw 'status 未写文件' }
Write-Host "  退出码: $code  $(if ($code -in 0,1) { '(合法)' } else { '(!! 意外)' })"

if ($code -notin 0, 1) { throw "status 返回了意外退出码 $code" }
if ($code -ne 0 -and -not (Get-Content $statusFile -Raw).Contains('未监听')) {
    throw '退出码 1 但文件内容不是「未监听」'
}

Write-Host ''
Write-Host '编译完成。菜单模式请直接双击 exe 或运行不带参数的版本。'
