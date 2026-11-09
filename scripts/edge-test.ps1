# Start a clean Edge test instance (loads the unpacked extension + enables CDP).
# The key flag is --disable-sync: without it, every new profile pops up "sync your browsing data across devices".
# That switch only affects this process; it does not touch the sync settings of your own Edge.
#
# Usage:
#   pwsh -File scripts/edge-test.ps1
#   pwsh -File scripts/edge-test.ps1 -Url http://127.0.0.1:8811/marker.pdf -DebugPort 9360
#   pwsh -File scripts/edge-test.ps1 -Reuse          # reopen with the same profile (saves disk)
#   pwsh -File scripts/edge-test.ps1 -ProfileName ci -ValidateOnly   # print the profile path only

param(
  [int]$DebugPort = 9358,
  [string]$Url = 'http://127.0.0.1:8811/article.html',
  [string]$ProfileName = '',
  [switch]$Reuse,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Profile names are user input and are later passed to Remove-Item. Restrict them to a
# single path segment and keep every profile under .edge-profiles so a typo cannot point
# the recursive delete at the repository or its parent.
if (-not $ProfileName) { $ProfileName = "edge-profile$DebugPort" }
if ($ProfileName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
  throw "Invalid -ProfileName '$ProfileName': use 1-64 chars from [A-Za-z0-9._-], starting with a letter or digit."
}
$profilesRoot = [IO.Path]::GetFullPath((Join-Path $root '.edge-profiles'))
$profileDir = [IO.Path]::GetFullPath((Join-Path $profilesRoot $ProfileName))
$profilePrefix = $profilesRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $profileDir.StartsWith($profilePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Invalid -ProfileName '$ProfileName': resolved path escapes $profilesRoot."
}

if ($ValidateOnly) {
  Write-Host "profile=$profileDir"
  exit 0
}

$ext = Join-Path $root '.output\chrome-mv3'
if (-not (Test-Path (Join-Path $ext 'manifest.json'))) {
  throw "Build output not found: $ext (run pnpm build first)"
}

if (-not $Reuse -and (Test-Path -LiteralPath $profileDir)) {
  # Only profiles created by this script carry the marker. If it is missing, refuse to
  # delete the directory: it may be a user profile or a mistyped path.
  $marker = Join-Path $profileDir '.pageask-edge-profile'
  if (-not (Test-Path -LiteralPath $marker)) {
    throw "Refusing to delete '$profileDir': it was not created by this script. Delete it manually if it is safe."
  }
  $userDataArg = [regex]::Escape("--user-data-dir=$profileDir")
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match $userDataArg) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction Stop
}

if (-not (Test-Path -LiteralPath $profileDir)) {
  New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $profileDir '.pageask-edge-profile') -Value 'pageask edge test profile'
} elseif (-not (Test-Path -LiteralPath (Join-Path $profileDir '.pageask-edge-profile'))) {
  # -Reuse must not adopt a directory this script did not create.
  throw "Refusing to reuse '$profileDir': it was not created by this script."
}

$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
)
$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) { throw "Edge not found; tried:`n$($candidates -join "`n")" }

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
    Write-Host "Extension loaded: $($extTarget.url)"
    Write-Host 'Note: dismiss the developer-mode warning with "Not now" (do not click "Remove").'
    exit 0
  }
}
Write-Warning 'CDP is up but the extension service worker did not appear: enable Developer mode at edge://extensions.'
exit 1
