# 起一个干净的 Edge 测试实例（加载未打包扩展 + 开 CDP）。
# 关键在 --disable-sync：不关同步的话，每次新建 profile 都会弹「在所有设备上同步你的浏览数据」。
# 这个开关只影响本进程，不会动你自己那份 Edge 的同步设置。
#
# 用法：
#   pwsh -File scripts/edge-test.ps1
#   pwsh -File scripts/edge-test.ps1 -Url http://127.0.0.1:8811/marker.pdf -DebugPort 9360
#   pwsh -File scripts/edge-test.ps1 -Reuse          # 用同一个 profile 重开（省得占盘）

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

# profile 目录：默认按端口号命名，避免互相踩
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
  '--disable-sync'                       # 不弹同步确认
  '--no-first-run'
  '--no-default-browser-check'
  '--disable-features=msImplicitSignin'  # 不自动带登录态
  '--window-size=1360,920'
  '--window-position=0,0'
  $Url
)

$p = Start-Process $exe -PassThru -ArgumentList $edgeArgs
Write-Host "edge pid=$($p.Id) profile=$profileDir port=$DebugPort"

# 等 CDP 起来，顺带确认扩展确实加载了
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
