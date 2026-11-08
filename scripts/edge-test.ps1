# Start a clean Edge test instance (loads the unpacked extension + enables CDP).
# The key flag is --disable-sync: without it, every new profile pops up "sync your browsing data across devices".
# That switch only affects this process; it does not touch the sync settings of your own Edge.
#
# Usage:
#   pwsh -File scripts/edge-test.ps1
#   pwsh -File scripts/edge-test.ps1 -Url http://127.0.0.1:8811/marker.pdf -DebugPort 9360
#   pwsh -File scripts/edge-test.ps1 -Reuse          # reopen with the same profile (saves disk)

param(
  [int]$DebugPort = 9358,
  [string]$Url = 'http://127.0.0.1:8811/article.html',
  [string]$ProfileName = '',
  [switch]$Reuse
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root '.output\chrome-mv3'
if (-not (Test-Path (Join-Path $ext 'manifest.json'))) {
  throw "找不到构建产物：$ext（先跑 pnpm build）"
}

# profile dir: named after the port by default, so instances do not collide
if (-not $ProfileName) { $ProfileName = ".edge-profile$DebugPort" }
$profileDir = Join-Path $root $ProfileName

if (-not $Reuse -and (Test-Path $profileDir)) {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
    Where-Object { $_.CommandLine -like "*$ProfileName*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
}

$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
)
$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) { throw "找不到 Edge，试过：`n$($candidates -join "`n")" }

$edgeArgs = @(
  "--user-data-dir=$profileDir"
  "--load-extension=$ext"
  "--remote-debugging-port=$DebugPort"
  '--disable-sync'                       # no sync confirmation popup
  '--no-first-run'
  '--no-default-browser-check'
  '--disable-features=msImplicitSignin'  # no implicit sign-in
  '--window-size=1360,920'
  '--window-position=0,0'
  $Url
)

$p = Start-Process $exe -PassThru -ArgumentList (($edgeArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' ')
Write-Host "edge pid=$($p.Id) profile=$profileDir port=$DebugPort"

# Wait for CDP to come up, and confirm the extension really got loaded
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try { $targets = Invoke-RestMethod "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 2 } catch { continue }
  $extTarget = $targets | Where-Object { $_.url -like 'chrome-extension://*/background.js' } | Select-Object -First 1
  if ($extTarget) {
    Write-Host "扩展已加载：$($extTarget.url)"
    Write-Host "提示：还要自己点一次「以后再说」关掉开发者模式警告（别点「关闭扩展」）。"
    exit 0
  }
}
Write-Warning 'CDP 起来了但没看到扩展的 service worker：检查 edge://extensions 是否开着「开发人员模式」。'
exit 1
