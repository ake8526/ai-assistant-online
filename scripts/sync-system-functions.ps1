# Keep OneDrive doc identical to the repo public file.
# Source of truth: ai-assistant-online/public/system-functions.html
$ErrorActionPreference = "Stop"
$online = Resolve-Path (Join-Path $PSScriptRoot "..")
$src = Join-Path $online "public\system-functions.html"
$dst = Join-Path (Split-Path $online -Parent) "ฟังก์ชันทั้งระบบ-AI-Assistant.html"
if (-not (Test-Path $src)) { throw "Missing $src" }
Copy-Item -Force $src $dst
Write-Host "OK synced system-functions.html -> $dst"
