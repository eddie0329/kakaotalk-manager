$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$script = Join-Path $root 'native\windows\chat-reader.ps1'
# Compile the real C# UIA worker and exercise its actual line protocol without private chat input.
$reply = '{"id":1,"op":"list","room":""}' | & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Mta -ExecutionPolicy Bypass -File $script
if ($LASTEXITCODE -ne 0) { throw 'Windows accessibility worker failed to compile or start.' }
$packet = $reply | ConvertFrom-Json
if ($packet.id -ne 1 -or $packet.capture.status -notin @('ok', 'not_running')) { throw 'Windows accessibility protocol smoke check failed.' }
Write-Host 'Windows UI Automation worker compilation and protocol smoke check passed (not a KakaoTalk integration test).'
