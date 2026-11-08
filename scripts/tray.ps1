# PageAsk 托盘程序（Windows）
#
# 双击 / `pnpm tray` 运行：常驻托盘，负责
#   1) 启动本地后端（node server/index.mjs）
#   2) 看门狗：每 4 秒探一次端口，后端挂了自动拉起
#   3) 菜单里：状态、启动、停止、重启、打开日志、打开数据目录、开机自启、退出
#      退出时只停掉自己拉起的后端（外部 pnpm server 不动）
#
# 参数：
#   -Port 8787        后端端口
#   -InstallAutostart 只写开机自启的快捷方式，不启动托盘
#   -RemoveAutostart  只删开机自启
#   -Diagnose         不启动托盘，打印后端状态与自启命令后退出（排查用）
#
# 说明：只用 PowerShell 自带能力（WinForms 托盘 + 快捷方式 COM），不引任何依赖。

[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$InstallAutostart,
  [switch]$RemoveAutostart,
  [switch]$Diagnose
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 托盘文案放在 scripts/i18n/<culture>/Tray.psd1，按系统 UI 语言取；
# 先试完整 culture，再试语言前缀，最后回退 en-US / zh-CN。日志（Write-Tray）保持英文。
function Get-TrayStrings {
  param([string]$Culture)
  $base = Join-Path $PSScriptRoot 'i18n'
  $lang = if ($Culture) { ($Culture -split '-')[0] } else { '' }
  $tried = @()
  foreach ($c in @($Culture, $lang, 'en-US', 'zh-CN')) {
    if (-not $c -or $tried -contains $c) { continue }
    $tried += $c
    if (-not (Test-Path (Join-Path (Join-Path $base $c) 'Tray.psd1'))) { continue }
    try {
      return Import-LocalizedData -BaseDirectory $base -FileName 'Tray.psd1' -UICulture $c -ErrorAction Stop
    } catch { }
  }
  throw "missing tray strings: $base\<culture>\Tray.psd1"
}
$script:Tray = Get-TrayStrings -Culture $PSUICulture

$script:Root = Split-Path -Parent $PSScriptRoot
$script:DataDir = Join-Path $script:Root 'server\data'
$script:TrayLog = Join-Path $script:DataDir 'tray.log'
$script:ServerErr = Join-Path $script:DataDir 'server.err.log'
$script:Port = $Port
$script:Child = $null
$script:Starts = 0
$script:WasDown = $false
$script:PortBlocked = $false
# 看门狗退避：连续失败时 10s → 20s → 40s → 60s，成功后重置
$script:RestartDelay = 10
$script:NextRestartAt = [datetime]::MinValue
# 「用户点了停止」和「后端自己崩了」要区分开：前者看门狗必须闭嘴，否则刚停就被拉起来
$script:StoppedByUser = $false

New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null

function Write-Tray([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $script:TrayLog -Value $line -Encoding utf8
}

function Get-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

# 后端状态：up = 确认是我们的后端；foreign = 端口被别的程序占用；down = 没人监听。
# 只认 /health/live 的 {ok,app}，不再用 TCP connect 当“活着”的证据——
# 否则任何程序占了 8787，托盘都会显示“运行中”，真正的后端永远起不来。
function Get-BackendState {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Port)/health/live" -UseBasicParsing -TimeoutSec 2
    $j = $r.Content | ConvertFrom-Json
    if ($j.ok -eq $true -and $j.app -eq 'pageask') { return 'up' }
    return 'foreign'
  } catch {
    # HTTP 不通不代表端口空着：再探一次 TCP，能连上就是别人占着
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $iar = $client.BeginConnect('127.0.0.1', $script:Port, $null, $null)
      if ($iar.AsyncWaitHandle.WaitOne(400)) {
        $client.EndConnect($iar)
        return 'foreign'
      }
    } catch { } finally {
      $client.Close()
    }
    return 'down'
  }
}

function Test-Backend {
  return (Get-BackendState) -eq 'up'
}

function Get-HealthModel {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Port)/health" -UseBasicParsing -TimeoutSec 3
    $j = $r.Content | ConvertFrom-Json
    return [string]$j.model
  } catch {
    return $null
  }
}

# 上次是不是崩溃/被强杀退出的（后端在 run.json 里留了标记）
function Get-AbnormalExit {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Port)/health" -UseBasicParsing -TimeoutSec 3
    $j = $r.Content | ConvertFrom-Json
    return [bool]$j.lifecycle.abnormalPreviousExit
  } catch {
    return $false
  }
}

function Start-Backend {
  $state = Get-BackendState
  if ($state -eq 'up') { return $true }
  if ($state -eq 'foreign') {
    # 8787 被别的服务占着：再起 node 只会 EADDRINUSE 反复崩溃，先别试
    if (-not $script:PortBlocked) {
      Write-Tray ("port {0} is occupied by another program; not starting" -f $script:Port)
      $script:PortBlocked = $true
    }
    return $false
  }
  $script:PortBlocked = $false

  $node = Get-NodeExe
  if (-not $node) {
    Write-Tray 'start failed: node.exe not found'
    return $false
  }

  # Key 只在 ~/.config/pageask/settings.json（配置页维护），这里不做任何环境变量兜底

  # 退出后把控制台窗口一起收掉：node 本身没窗口，-WindowStyle Hidden 只是保险
  $script:Child = Start-Process -FilePath $node `
    -ArgumentList 'server/index.mjs' `
    -WorkingDirectory $script:Root `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardError $script:ServerErr

  $script:Starts++
  Write-Tray ("start: pid={0} port={1}" -f $script:Child.Id, $script:Port)

  # 等端口起来（最多 8 秒）
  for ($i = 0; $i -lt 16; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Backend) {
      if (Get-AbnormalExit) {
        Write-Tray 'previous run ended abnormally; pending question will be restored in the side panel'
        # 侧栏打开时会把没回答的那条提问放回输入框，这里只提醒一句
        if ($notify) {
          $notify.ShowBalloonTip(4000, $script:Tray.AppName, $script:Tray.BalloonAbnormal, [System.Windows.Forms.ToolTipIcon]::Warning)
        }
      }
      return $true
    }
    if ($script:Child.HasExited) {
      Write-Tray ("start aborted: node exited with {0} (see server.err.log)" -f $script:Child.ExitCode)
      return $false
    }
  }
  return $false
}

function Stop-Backend {
  # 先请后端自己退出：会关库、做一次 WAL checkpoint，比直接杀进程安全。
  # 开了 PAGEASK_TOKEN 时这里没有令牌，会 403，退回下面的强杀逻辑。
  if (Test-Backend) {
    $origin = "http://127.0.0.1:$($script:Port)"
    try {
      Invoke-WebRequest -Uri "$origin/api/shutdown" -Method Post -Headers @{ Origin = $origin } `
        -UseBasicParsing -TimeoutSec 3 | Out-Null
      for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Test-Backend)) { break }
      }
      Write-Tray 'graceful shutdown'
    } catch {
      Write-Tray ("graceful shutdown failed: {0}" -f $_.Exception.Message)
    }
  }

  $killed = @()

  if ($script:Child -and -not $script:Child.HasExited) {
    try { Stop-Process -Id $script:Child.Id -Force -ErrorAction Stop; $killed += $script:Child.Id } catch { }
  }

  # 兜底：收掉监听该端口的进程——但必须先确认它真的是 PageAsk 后端，
  # 不能按端口盲杀（8787 可能被别的服务占用）
  try {
    $pids = @(Get-NetTCPConnection -LocalPort $script:Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($pidToCheck in $pids) {
      if (-not $pidToCheck -or $pidToCheck -eq 0) { continue }
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToCheck" -ErrorAction SilentlyContinue
      if (-not $proc) { continue }
      if ($proc.Name -ne 'node.exe' -or $proc.CommandLine -notmatch 'server[\\/]index\.mjs') {
        Write-Tray ("skip pid={0} ({1}): not a PageAsk backend" -f $pidToCheck, $proc.Name)
        continue
      }
      try { Stop-Process -Id $pidToCheck -Force -ErrorAction Stop; $killed += $pidToCheck } catch { }
    }
  } catch { }

  if ($killed.Count -gt 0) { Write-Tray ("stop: pid={0}" -f ($killed -join ',')) }
  $script:Child = $null
}

function Restart-Backend {
  Stop-Backend
  Start-Sleep -Milliseconds 300
  [void](Start-Backend)
}

# ---------- 开机自启 ----------

$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$Shortcut = Join-Path $StartupDir $script:Tray.AutostartShortcutName

# 优先 PowerShell 7（pwsh），找不到才退回系统自带的 5.1。
# 注意：Windows 没有「默认 PowerShell」这种全局开关，powershell.exe 永远是 5.1，
# 所以这里的办法是「把入口里的解释器写死成 pwsh」。
function Get-Pwsh7 {
  # 顺序有讲究：先找「不会随版本号变」的稳定路径。
  # Get-Command pwsh 在 Store/MSIX 版上返回的是 ...\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\pwsh.exe，
  # 一旦商店更新版本，这个路径就失效了，所以它放最后当兜底。
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

function Get-AutostartCommand {
  $trayScript = Join-Path $script:Root 'scripts\tray.ps1'
  # 自启必须带上当前端口，否则用 -Port 9000 装完自启，重启后又跑回 8787
  $portArgs = "-Port $($script:Port)"
  $pwsh = Get-Pwsh7
  if ($pwsh) {
    # MSIX 版 pwsh 的执行策略是锁死的（LocalMachine=RemoteSigned），
    # 但本地未打标记的脚本本来就允许运行，-ExecutionPolicy Bypass 只是保险。
    return @{
      Exe  = $pwsh
      Args = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $trayScript + '" ' + $portArgs
    }
  }
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path $psExe)) { $psExe = (Get-Process -Id $PID).Path }
  return @{
    Exe  = $psExe
    Args = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $trayScript + '" ' + $portArgs
  }
}

function Install-Autostart {
  $cmd = Get-AutostartCommand
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Shortcut)
  $lnk.TargetPath = $cmd.Exe
  $lnk.Arguments = $cmd.Args
  $lnk.WorkingDirectory = $script:Root
  $lnk.WindowStyle = 7
  $lnk.Description = $script:Tray.AutostartDescription
  $lnk.Save()
  Write-Tray ("autostart installed: {0} -> {1} (port {2})" -f $Shortcut, $cmd.Exe, $script:Port)
}

function Remove-Autostart {
  if (Test-Path $Shortcut) { Remove-Item $Shortcut -Force }
  Write-Tray 'autostart removed'
}

if ($Diagnose) {
  $state = Get-BackendState
  $cmd = Get-AutostartCommand
  Write-Host "port: $($script:Port)"
  Write-Host "backend state: $state"
  Write-Host "autostart exe: $($cmd.Exe)"
  Write-Host "autostart args: $($cmd.Args)"
  exit 0
}

if ($InstallAutostart) { Install-Autostart; Write-Host ($script:Tray.HostAutostartInstalled -f $Shortcut); exit 0 }
if ($RemoveAutostart) { Remove-Autostart; Write-Host $script:Tray.HostAutostartRemoved; exit 0 }

# ---------- 单实例 ----------

# 单实例按端口隔离：同一个端口只允许一个托盘，不同端口可以各跑一个
$mutex = New-Object System.Threading.Mutex($false, "PageAskTraySingleton-$($script:Port)")
$acquired = $false
try {
  $acquired = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  # 上一个托盘崩溃时没 ReleaseMutex，这里接管，不要因此拒绝启动
  $acquired = $true
}
if (-not $acquired) {
  $mutex.Dispose()
  Write-Host ($script:Tray.HostAlreadyRunning -f $script:Port)
  exit 0
}

# ---------- 托盘 ----------

$iconPath = Join-Path $script:Root 'public\icon\32.png'
$bmp = [System.Drawing.Bitmap]::FromFile($iconPath)
$hicon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hicon)
$bmp.Dispose()

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Visible = $true
$notify.Text = $script:Tray.TrayTooltip

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miStatus = New-Object System.Windows.Forms.ToolStripMenuItem $script:Tray.MenuStatus
$miStatus.Enabled = $false
$miStart = New-Object System.Windows.Forms.ToolStripMenuItem $script:Tray.MenuStart
$miStop = New-Object System.Windows.Forms.ToolStripMenuItem $script:Tray.MenuStop
$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem $script:Tray.MenuRestart
$miConsole = New-Object System.Windows.Forms.ToolStripMenuItem $script:Tray.MenuConfig
$miLogs = New-Object System.Windows.Forms.ToolStripMenuItem $script:Tray.MenuLogs
$miData = New-Object System.Windows.Forms.ToolStripMenuItem $script:Tray.MenuData
$miAuto = New-Object System.Windows.Forms.ToolStripMenuItem $script:Tray.MenuAutostart
$miAuto.CheckOnClick = $true
$miAuto.Checked = Test-Path $Shortcut
$miQuit = New-Object System.Windows.Forms.ToolStripMenuItem $script:Tray.MenuQuit

[void]$menu.Items.Add($miStatus)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miStart)
[void]$menu.Items.Add($miStop)
[void]$menu.Items.Add($miRestart)
[void]$menu.Items.Add($miConsole)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miLogs)
[void]$menu.Items.Add($miData)
[void]$menu.Items.Add($miAuto)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($miQuit)

$notify.ContextMenuStrip = $menu

$refresh = {
  $state = Get-BackendState
  $up = $state -eq 'up'
  if ($up) {
    $model = Get-HealthModel
    $suffix = if ($model) { $script:Tray.StatusModelSuffix -f $model } else { '' }
    $miStatus.Text = $script:Tray.StatusRunning -f $script:Port, $suffix
    $notify.Text = $script:Tray.NotifyRunning
  } elseif ($state -eq 'foreign') {
    # 端口被别人占着：说清楚，别让用户以为是我们没起来
    $miStatus.Text = $script:Tray.StatusPortForeign -f $script:Port
    $notify.Text = $script:Tray.NotifyPortForeign
  } elseif ($script:StoppedByUser) {
    # 手动停的：别再过一会儿自己冒出来，状态也要说清楚是「你停的」
    $miStatus.Text = $script:Tray.StatusStoppedManual
    $notify.Text = $script:Tray.NotifyStoppedManual
  } else {
    $miStatus.Text = $script:Tray.StatusStopped
    $notify.Text = $script:Tray.NotifyStopped
  }
  $miStart.Enabled = $state -eq 'down'
  $miStop.Enabled = $up
  $miRestart.Enabled = $state -ne 'foreign'
  $miAuto.Checked = Test-Path $Shortcut
}

$menu.add_Opening({ & $refresh })

$miStart.add_Click({
  $script:StoppedByUser = $false
  $script:WasDown = $false
  $script:RestartDelay = 10
  $script:NextRestartAt = [datetime]::MinValue
  Start-Backend | Out-Null
  & $refresh
})
$miStop.add_Click({
  $script:StoppedByUser = $true
  Stop-Backend
  Write-Tray 'stop by user: watchdog paused'
  & $refresh
})
$miRestart.add_Click({
  $script:StoppedByUser = $false
  $script:WasDown = $false
  $script:RestartDelay = 10
  $script:NextRestartAt = [datetime]::MinValue
  Restart-Backend
  & $refresh
})
$miConsole.add_Click({
  # 配置页要后端在跑；没跑就先拉起来再打开
  if (-not (Test-Backend)) {
    $script:StoppedByUser = $false
    $script:WasDown = $false
    Start-Backend | Out-Null
    & $refresh
  }
  Start-Process ("http://127.0.0.1:{0}/settings" -f $script:Port)
})
$miLogs.add_Click({
  $p = Join-Path $script:DataDir 'pageask.log'
  if (Test-Path $p) { Start-Process notepad.exe -ArgumentList "`"$p`"" } else { Start-Process $script:DataDir }
})
$miData.add_Click({ Start-Process explorer.exe -ArgumentList "`"$script:DataDir`"" })
$miAuto.add_Click({
  if ($miAuto.Checked) { Install-Autostart } else { Remove-Autostart }
})
$miQuit.add_Click({
  $script:Quitting = $true
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notify.add_DoubleClick({ & $refresh; $menu.Show([System.Windows.Forms.Cursor]::Position) })

# ---------- 看门狗 ----------

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
  if ($script:Quitting) { return }
  # 用户手动停的，看门狗不许插手（否则「停止」按钮形同虚设）
  if ($script:StoppedByUser) {
    $script:WasDown = $false
    return
  }

  $state = Get-BackendState
  if ($state -eq 'up') {
    if ($script:WasDown) {
      $script:WasDown = $false
      $notify.ShowBalloonTip(3000, $script:Tray.AppName, $script:Tray.BalloonRecovered, [System.Windows.Forms.ToolTipIcon]::Info)
    }
    $script:RestartDelay = 10
    $script:NextRestartAt = [datetime]::MinValue
    return
  }

  if ($state -eq 'foreign') {
    # 端口被别人占着：反复起 node 只会 EADDRINUSE，记一次日志就停手
    if (-not $script:PortBlocked) {
      Write-Tray ("watchdog: port {0} occupied by another program; auto-restart paused" -f $script:Port)
      $script:PortBlocked = $true
    }
    $script:WasDown = $true
    return
  }
  $script:PortBlocked = $false
  $script:WasDown = $true

  # 崩溃循环退避：失败后 10s → 20s → 40s → 60s，成功或手动操作后重置
  if ((Get-Date) -lt $script:NextRestartAt) { return }

  Write-Tray 'watchdog: backend down, restarting'
  $ok = Start-Backend
  if ($ok) {
    $script:RestartDelay = 10
    $script:NextRestartAt = [datetime]::MinValue
    $notify.ShowBalloonTip(3000, $script:Tray.AppName, $script:Tray.BalloonRestarted, [System.Windows.Forms.ToolTipIcon]::Warning)
  } else {
    $script:RestartDelay = [Math]::Min(60, $script:RestartDelay * 2)
    $script:NextRestartAt = (Get-Date).AddSeconds($script:RestartDelay)
    Write-Tray ("watchdog: restart failed; next attempt in {0}s" -f $script:RestartDelay)
  }
})
$timer.Start()

Write-Tray ("tray started: port={0} node={1}" -f $script:Port, (Get-NodeExe))
[void](Start-Backend)

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()

  # 退出托盘时收掉「自己拉起的」后端，避免留下无主 node；
  # 如果是用户自己在别的终端 pnpm server 起的（Child 为空），不要误杀。
  if ($script:Child -and -not $script:Child.HasExited) {
    Stop-Backend
    Write-Tray 'child backend stopped on quit'
  }

  # 释放单实例锁，避免下次启动被自己的残留 mutex 挡住
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
  Write-Tray 'tray exited'
}
