# 启动 PageAsk 本地后端（Windows）
#
# 配置（Key / 上游地址 / 默认模型）存在 server/data/settings.json，由后端配置页维护：
#   http://127.0.0.1:8787/settings
# 这里不读任何 API Key 环境变量——配置只有一个来源，就是那个 JSON 文件。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Set-Location $root
node server/index.mjs
