# PageAsk 托盘程序（Windows）
#
# 双击 / `pnpm tray` 运行：常驻托盘，负责
#   1) 启动本地后端（node server/index.mjs）
#   2) 看门狗：每 4 秒探一次端口，后端挂了自动拉起
#   3) 菜单里：状态、启动、停止、重启、打开日志、打开数据目录、开机自启、退出
#
# 参数：
#   -Port 8787        后端端口
#   -InstallAutostart 只写开机自启的快捷方式，不启动托盘
#   -RemoveAutostart  只删开机自启
#
# 说明：只用 PowerShell 自带能力（WinForms 托盘 + 快捷方式 COM），不引任何依赖。

[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$InstallAutostart,
  [switch]$RemoveAutostart
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Root = Split-Path -Parent $PSScriptRoot
$script:DataDir = Join-Path $script:Root 'server\data'
$script:TrayLog = Join-Path $script:DataDir 'tray.log'
$script:ServerErr = Join-Path $script:DataDir 'server.err.log'
$script:Port = $Port
$script:Child = $null
$script:LastStart = [datetime]::MinValue
$script:Starts = 0
$script:WasDown = $false
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

# 探活：优先问 /health/live（确认是我们的后端），旧版本没有这个端点时退回 TCP 端口探测
function Test-Backend {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Port)/health/live" -UseBasicParsing -TimeoutSec 2
    $j = $r.Content | ConvertFrom-Json
    if ($j.ok -eq $true -and $j.app -eq 'pageask') { return $true }
  } catch { }

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $script:Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(600)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
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
  if (Test-Backend) { return $true }

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

  $script:LastStart = Get-Date
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
          $notify.ShowBalloonTip(4000, 'PageAsk', '上次后端没有正常退出；没回答的提问会在侧栏打开时回到输入框。', [System.Windows.Forms.ToolTipIcon]::Warning)
        }
      }
      return $true
    }
    if ($script:Child.HasExited) {
      Write-Tray ("start aborted: node exited with {0}（详见 server.err.log）" -f $script:Child.ExitCode)
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
        Write-Tray ("skip pid={0} ({1})：不是 PageAsk 后端" -f $pidToCheck, $proc.Name)
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
$Shortcut = Join-Path $StartupDir 'PageAsk 托盘.lnk'

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

function Install-Autostart {
  $pwsh = Get-Pwsh7
  if ($pwsh) {
    $psExe = $pwsh
    # MSIX 版 pwsh 的执行策略是锁死的（LocalMachine=RemoteSigned），
    # 但本地未打标记的脚本本来就允许运行，-ExecutionPolicy Bypass 只是保险。
    $args = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $script:Root 'scripts\tray.ps1') + '"'
  } else {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path $psExe)) { $psExe = (Get-Process -Id $PID).Path }
    $args = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $script:Root 'scripts\tray.ps1') + '"'
  }
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Shortcut)
  $lnk.TargetPath = $psExe
  $lnk.Arguments = $args
  $lnk.WorkingDirectory = $script:Root
  $lnk.WindowStyle = 7
  $lnk.Description = 'PageAsk 后端托盘（守护进程）'
  $lnk.Save()
  Write-Tray ("autostart installed: {0} -> {1}" -f $Shortcut, $psExe)
}

function Remove-Autostart {
  if (Test-Path $Shortcut) { Remove-Item $Shortcut -Force }
  Write-Tray 'autostart removed'
}

if ($InstallAutostart) { Install-Autostart; Write-Host "已设置开机自启：$Shortcut"; exit 0 }
if ($RemoveAutostart) { Remove-Autostart; Write-Host '已取消开机自启'; exit 0 }

# ---------- 单实例 ----------

$mutex = New-Object System.Threading.Mutex($false, 'PageAskTraySingleton')
if (-not $mutex.WaitOne(0)) {
  Write-Host 'PageAsk 托盘已经在运行了。'
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
$notify.Text = 'PageAsk 后端'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$miStatus.Enabled = $false
$miStart = New-Object System.Windows.Forms.ToolStripMenuItem '启动后端'
$miStop = New-Object System.Windows.Forms.ToolStripMenuItem '停止后端'
$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem '重启后端'
$miConsole = New-Object System.Windows.Forms.ToolStripMenuItem '配置…'
$miLogs = New-Object System.Windows.Forms.ToolStripMenuItem '打开日志'
$miData = New-Object System.Windows.Forms.ToolStripMenuItem '打开数据目录'
$miAuto = New-Object System.Windows.Forms.ToolStripMenuItem '开机自启'
$miAuto.CheckOnClick = $true
$miAuto.Checked = Test-Path $Shortcut
$miQuit = New-Object System.Windows.Forms.ToolStripMenuItem '退出'

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
  $up = Test-Backend
  if ($up) {
    $model = Get-HealthModel
    $miStatus.Text = '运行中 · 127.0.0.1:{0}{1}' -f $script:Port, $(if ($model) { " · $model" } else { '' })
    $notify.Text = 'PageAsk 后端：运行中'
  } elseif ($script:StoppedByUser) {
    # 手动停的：别再过一会儿自己冒出来，状态也要说清楚是「你停的」
    $miStatus.Text = '已停止（手动）'
    $notify.Text = 'PageAsk 后端：已停止（手动）'
  } else {
    $miStatus.Text = '已停止'
    $notify.Text = 'PageAsk 后端：已停止'
  }
  $miStart.Enabled = -not $up
  $miStop.Enabled = $up
  $miRestart.Enabled = $true
  $miAuto.Checked = Test-Path $Shortcut
}

$menu.add_Opening({ & $refresh })

$miStart.add_Click({
  $script:StoppedByUser = $false
  $script:WasDown = $false
  Start-Backend | Out-Null
  & $refresh
})
$miStop.add_Click({
  $script:StoppedByUser = $true
  Stop-Backend
  Write-Tray 'stop by user：看门狗暂停自动重启'
  & $refresh
})
$miRestart.add_Click({
  $script:StoppedByUser = $false
  $script:WasDown = $false
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
    if ($script:WasDown) { $script:WasDown = $false }
    return
  }

  if (Test-Backend) {
    if ($script:WasDown) {
      $script:WasDown = $false
      $notify.ShowBalloonTip(3000, 'PageAsk', '后端已恢复。', [System.Windows.Forms.ToolTipIcon]::Info)
    }
    return
  }

  $script:WasDown = $true
  # 别在崩溃循环里疯狂重启：10 秒内最多一次
  if (((Get-Date) - $script:LastStart).TotalSeconds -lt 10) { return }

  Write-Tray 'watchdog: backend down, restarting'
  $ok = Start-Backend
  if ($ok) {
    $notify.ShowBalloonTip(3000, 'PageAsk', '后端未响应，已自动重启。', [System.Windows.Forms.ToolTipIcon]::Warning)
  } else {
    Write-Tray 'watchdog: restart failed'
  }
})
$timer.Start()

Write-Tray ("tray started: port={0} node={1}" -f $script:Port, (Get-NodeExe))
[void](Start-Backend)

[System.Windows.Forms.Application]::Run()
$timer.Stop()
Write-Tray 'tray exited'
