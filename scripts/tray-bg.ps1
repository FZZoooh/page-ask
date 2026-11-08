# Move the tray from "hogging the terminal in the foreground" to the background:
#   pnpm tray      -> runs in the foreground; only Ctrl+C exits it, and the terminal stays occupied
#   pnpm tray:bg   -> use this: new process + hidden window, the command returns immediately
#
# The mechanism is plain Start-Process: it creates a new process (with its own console, hidden by -WindowStyle Hidden),
# and the current terminal does not wait for it, so the prompt is back at once. Not the nohup / setsid unix trick.
#
# Note: this is a "background process inside the user session"; logoff/reboot kills it — for autostart use
# "autostart" in the tray menu (writes a Startup shortcut).
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
# PowerShell variables are case-insensitive: `$tray` and the `$Tray` dictionary are the same variable,
# so the path must not be called `$tray` — the hashtable would overwrite it and Test-Path would fail.
$trayScript = Join-Path $root 'scripts\tray.ps1'
$i18n = Join-Path $PSScriptRoot 'i18n'
try {
  $Tray = Import-LocalizedData -BaseDirectory $i18n -FileName 'Tray.psd1' -UICulture $PSUICulture
} catch {
  $Tray = Import-LocalizedData -BaseDirectory $i18n -FileName 'Tray.psd1' -UICulture 'zh-CN'
}
if (-not (Test-Path $trayScript)) { throw ($Tray.BgMissing -f $trayScript) }

# Keep in sync with Get-Pwsh7 in tray.ps1: stable paths first, Get-Command only as the last fallback
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
  $argv = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $trayScript)
} else {
  $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $trayScript)
}

$proc = Start-Process -FilePath $exe -ArgumentList $argv -WorkingDirectory $root -WindowStyle Hidden -PassThru
Write-Host ($Tray.BgStarted -f $proc.Id, (Split-Path -Leaf $exe))
Write-Host ($Tray.BgLog -f (Join-Path $root 'server\data\tray.log'))
Write-Host $Tray.BgStop
