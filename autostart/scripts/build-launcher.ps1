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

# System.Management 用于读 CommandLine（进程匹配）
& $csc /nologo /target:exe /platform:anycpu /optimize+ `
    /out:$exe `
    /r:System.Windows.Forms.dll `
    /r:System.Drawing.dll `
    /r:System.Management.dll `
    $src

if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }
if (-not (Test-Path $exe)) { throw '编译没有产出 exe' }

$size = (Get-Item $exe).Length
Write-Host "已生成：$exe  ($size bytes)" -ForegroundColor Green

# 冒烟测试：只跑 status，不该弹菜单
$out = & $exe status 2>&1
$code = $LASTEXITCODE
Write-Host ''
Write-Host 'status 冒烟测试：'
$out | ForEach-Object { Write-Host "  $_" }
Write-Host "  退出码: $code"

if ($code -notin 0, 1) {
    throw "status 返回了意外退出码 $code"
}

Write-Host ''
Write-Host '编译完成。菜单模式请直接双击 exe 或运行不带参数的版本。'
