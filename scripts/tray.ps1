# PageAsk tray app (Windows)
#
# Run by double-click / `pnpm tray`: stays resident in the tray and
#   1) starts the local backend (node server/index.mjs)
#   2) watchdog: probes the port every 4s and restarts the backend when it dies
#   3) menu: status, start, stop, restart, open log, open data dir, autostart, quit
#      on quit it stops only the backend it started (an external `pnpm server` is left alone)
#
# The backend port and the data directory come from ~/.config/pageask/settings.json — the same file
# the backend and the settings page use. No switch or environment variable can override them.
#
# Parameters:
#   -InstallAutostart only write the autostart shortcut; do not start the tray
#   -RemoveAutostart  only remove the autostart entry
#   -Diagnose         no tray: print backend state and autostart command, then exit (for debugging)
#
# Notes: only built-in PowerShell capabilities (WinForms tray + shortcut COM); no dependencies.

[CmdletBinding()]
param(
  [switch]$InstallAutostart,
  [switch]$RemoveAutostart,
  [switch]$Diagnose
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Tray strings live in scripts/i18n/<culture>/Tray.psd1, chosen by the system UI language:
# try the full culture first, then the language prefix, then fall back to en-US / zh-CN. Logs stay English.
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
$script:Port = 8787
$script:Child = $null
$script:Starts = 0
$script:WasDown = $false
$script:PortBlocked = $false
# Watchdog backoff: 10s → 20s → 40s → 60s on consecutive failures; reset after a success
$script:RestartDelay = 10
$script:NextRestartAt = [datetime]::MinValue
# Separate "user clicked stop" from "backend crashed": the watchdog stays silent for the first, else it revives
$script:StoppedByUser = $false

function Write-Tray([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $script:TrayLog -Value $line -Encoding utf8
}

# The one config source: settings.json in the user profile. Returns $null when it is missing or
# broken; callers then use the defaults instead of inventing a second config location.
function Get-PageAskSettings {
  # not `$home`: that is the read-only automatic variable (and names are case-insensitive)
  $userHome = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { return $null }
  $file = Join-Path $userHome '.config\pageask\settings.json'
  if (-not (Test-Path $file)) { return $null }
  try {
    return Get-Content -Raw -Path $file | ConvertFrom-Json
  } catch {
    Write-Tray ("settings.json is not valid JSON; using defaults: {0}" -f $_.Exception.Message)
    return $null
  }
}

function Get-ConfiguredPort {
  $s = Get-PageAskSettings
  if ($s -and $s.port -and [int]$s.port -ge 1 -and [int]$s.port -le 65535) { return [int]$s.port }
  return 8787
}

# Same rules as server/settings.mjs: empty means <repo>\server\data, "~" is the user profile,
# and a relative path is resolved against the repo root.
function Resolve-ConfiguredDataDir([string]$value) {
  if (-not $value) { return (Join-Path $script:Root 'server\data') }
  if ($value.StartsWith('~')) {
    $value = Join-Path $env:USERPROFILE $value.Substring(1).TrimStart('\', '/')
  }
  if ([System.IO.Path]::IsPathRooted($value)) { return $value }
  return (Join-Path $script:Root $value)
}

function Update-DataDir {
  $s = Get-PageAskSettings
  $wanted = Resolve-ConfiguredDataDir ($(if ($s) { [string]$s.dataDir } else { '' }))
  if ($wanted -eq $script:DataDir) { return }
  $script:DataDir = $wanted
  $script:TrayLog = Join-Path $script:DataDir 'tray.log'
  $script:ServerErr = Join-Path $script:DataDir 'server.err.log'
  New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null
}

$script:Port = Get-ConfiguredPort
Update-DataDir
New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null

function Get-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

# Backend state: up = confirmed our backend; foreign = another program owns the port; down = nobody listening.
# Only /health/live's {ok,app} counts; a TCP connect is no longer accepted as proof of "alive" —
# otherwise any program holding the port makes the tray say "running", and the real backend never starts.
function Get-BackendState {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Port)/health/live" -UseBasicParsing -TimeoutSec 2
    $j = $r.Content | ConvertFrom-Json
    if ($j.ok -eq $true -and $j.app -eq 'pageask') { return 'up' }
    return 'foreign'
  } catch {
    # HTTP failing does not mean the port is free: probe TCP once more; if it connects, someone else holds it
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

# Did the previous run die by crash or force-kill? (the backend leaves a marker in run.json)
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
    # The port is held by another service: another node would just EADDRINUSE-loop, so do not try
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

  # The key lives only in ~/.config/pageask/settings.json (maintained by the settings page); no env-var fallback

  # Kill the console window on exit too: node has no window of its own, -WindowStyle Hidden is just insurance
  $script:Child = Start-Process -FilePath $node `
    -ArgumentList 'server/index.mjs' `
    -WorkingDirectory $script:Root `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardError $script:ServerErr

  $script:Starts++
  Write-Tray ("start: pid={0} port={1}" -f $script:Child.Id, $script:Port)

  # Wait for the port to come up (8 seconds at most)
  for ($i = 0; $i -lt 16; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Backend) {
      if (Get-AbnormalExit) {
        Write-Tray 'previous run ended abnormally; pending question will be restored in the side panel'
        # The side panel puts the unanswered question back in the input box; here we only warn
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
  # Ask the backend to exit itself first: it closes the DB and does a WAL checkpoint, safer than killing it.
  # The call is same-origin (Origin header below), which the backend accepts whether or not a token is set.
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

  # Fallback: take down the process listening on the port — but first confirm it really is the PageAsk backend;
  # never kill blindly by port (another service may hold it).
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

# ---------- Autostart ----------

$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$Shortcut = Join-Path $StartupDir $script:Tray.AutostartShortcutName

# Prefer PowerShell 7 (pwsh); fall back to the built-in 5.1 only when it is missing.
# Note: Windows has no global "default PowerShell" switch — powershell.exe is always 5.1,
# so the trick here is to hard-wire the interpreter into the entry point.
function Get-Pwsh7 {
  # Order matters: look for stable paths that do not change with the version number first.
  # On the Store/MSIX build Get-Command pwsh returns ...\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\pwsh.exe,
  # which breaks as soon as the Store bumps the version, so it is kept last as a fallback.
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
  # No port argument: the tray reads settings.json on every start, so autostart always follows it
  $pwsh = Get-Pwsh7
  if ($pwsh) {
    # The MSIX pwsh build has a locked execution policy (LocalMachine=RemoteSigned),
    # but local unmarked scripts are allowed to run anyway; -ExecutionPolicy Bypass is just insurance.
    return @{
      Exe  = $pwsh
      Args = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $trayScript + '"'
    }
  }
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path $psExe)) { $psExe = (Get-Process -Id $PID).Path }
  return @{
    Exe  = $psExe
    Args = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $trayScript + '"'
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

# ---------- Single instance ----------

# Single instance is isolated per port: one tray per port, different ports may each run their own
$mutex = New-Object System.Threading.Mutex($false, "PageAskTraySingleton-$($script:Port)")
$acquired = $false
try {
  $acquired = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  # The previous tray crashed without ReleaseMutex; take the lock over instead of refusing to start
  $acquired = $true
}
if (-not $acquired) {
  $mutex.Dispose()
  Write-Host ($script:Tray.HostAlreadyRunning -f $script:Port)
  exit 0
}

# ---------- Tray ----------

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
    # Port taken by someone else: state it plainly so the user does not think we failed to start
    $miStatus.Text = $script:Tray.StatusPortForeign -f $script:Port
    $notify.Text = $script:Tray.NotifyPortForeign
  } elseif ($script:StoppedByUser) {
    # Stopped by hand: do not resurface later, and make the status say plainly "you stopped it"
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
  # The settings page needs the backend up; start it first if it is down, then open the page
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

# ---------- Watchdog ----------

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
  if ($script:Quitting) { return }

  # settings.json stays authoritative while the tray runs: follow a port / data-dir change at once
  $wantedPort = Get-ConfiguredPort
  if ($wantedPort -ne $script:Port) {
    Write-Tray ("watchdog: settings.json now asks for port {0}; restarting" -f $wantedPort)
    if (-not $script:StoppedByUser) { Stop-Backend }
    $script:Port = $wantedPort
    Update-DataDir
    if (-not $script:StoppedByUser) { [void](Start-Backend) }
    return
  }
  Update-DataDir

  # Stopped by the user: the watchdog must not interfere (else the Stop button means nothing)
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
    # Port taken by someone else: starting node again only gives EADDRINUSE, so log once and stop
    if (-not $script:PortBlocked) {
      Write-Tray ("watchdog: port {0} occupied by another program; auto-restart paused" -f $script:Port)
      $script:PortBlocked = $true
    }
    $script:WasDown = $true
    return
  }
  $script:PortBlocked = $false
  $script:WasDown = $true

  # Crash-loop backoff: 10s → 20s → 40s → 60s after failures; reset on success or manual action
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

  # On quit, stop the backend "we started ourselves" so no orphan node is left behind;
  # if the user started it with `pnpm server` in another terminal (Child is null), do not kill it by mistake.
  if ($script:Child -and -not $script:Child.HasExited) {
    Stop-Backend
    Write-Tray 'child backend stopped on quit'
  }

  # Release the single-instance lock so the next launch is not blocked by our own leftover mutex
  try { $mutex.ReleaseMutex() } catch { }
  $mutex.Dispose()
  Write-Tray 'tray exited'
}
