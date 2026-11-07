# 把托盘从「前台占着终端」甩到后台：
#   pnpm tray      -> 前台运行，Ctrl+C 才会退出，终端被占住
#   pnpm tray:bg   -> 用这个：新进程 + 隐藏窗口，命令立刻返回
#
# 原理就是 Start-Process：它会新建进程（自己带一个控制台，用 -WindowStyle Hidden 藏起来），
# 当前终端不等它，所以马上回到提示符。不是 nohup / setsid 那套 unix 手法。
#
# 注意：这是「用户会话内的后台进程」，注销/重启就没了——要开机自启请用托盘菜单里的
# 「开机自启」（写 Startup 快捷方式）。
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tray = Join-Path $root 'scripts\tray.ps1'
if (-not (Test-Path $tray)) { throw "找不到 $tray" }

# 和 tray.ps1 里的 Get-Pwsh7 保持一致：优先稳定路径，最后才用 Get-Command 兜底
function Get-Pwsh7 {
  foreach ($p in @(
      (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
      (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe')
    )) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  $cmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  return $null
}

$pwsh = Get-Pwsh7
if ($pwsh) {
  $exe = $pwsh
  $argv = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $tray)
} else {
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $tray)
}

$proc = Start-Process -FilePath $exe -ArgumentList $argv -WorkingDirectory $root -WindowStyle Hidden -PassThru
Write-Host ("已在后台启动托盘：pid={0}（{1}）" -f $proc.Id, (Split-Path -Leaf $exe))
Write-Host ("日志：{0}" -f (Join-Path $root 'server\data\tray.log'))
Write-Host '停止：托盘图标右键 → 退出；或 Stop-Process -Id 该 pid'
