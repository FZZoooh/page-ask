# Start the PageAsk local backend (Windows)
#
# Config (key / upstream URL / model / port / token / dataDir) lives in ~/.config/pageask/settings.json,
# managed by the settings page:
#   http://127.0.0.1:8787/settings
# No environment variable or argument is read here — config has exactly one source, that JSON file.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Set-Location $root
node server/index.mjs
