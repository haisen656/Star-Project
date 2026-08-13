param(
  [string]$InstallDirectory = "$env:LOCALAPPDATA\QuickDrop\bridge",
  [string]$WebOrigin = "https://star-project-1.vercel.app"
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
Copy-Item -Force (Join-Path $source 'src\server.mjs') (Join-Path $InstallDirectory 'server.mjs')

$launcher = Join-Path $InstallDirectory 'quickdrop-bridge.cmd'
@"
@echo off
set QUICKDROP_ALLOWED_ORIGINS=$WebOrigin,http://localhost:3000,http://127.0.0.1:3000
start "" /b "$node" "$InstallDirectory\server.mjs"
"@ | Set-Content -Encoding ascii $launcher

New-Item -Path 'HKCU:\Software\Classes\quickdrop-bridge' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\quickdrop-bridge' -Name '(Default)' -Value 'URL:QuickDrop Bridge Protocol'
Set-ItemProperty -Path 'HKCU:\Software\Classes\quickdrop-bridge' -Name 'URL Protocol' -Value ''
New-Item -Path 'HKCU:\Software\Classes\quickdrop-bridge\shell\open\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\quickdrop-bridge\shell\open\command' -Name '(Default)' -Value "`"$launcher`" `"%1`""

$startup = [Environment]::GetFolderPath('Startup')
Copy-Item -Force $launcher (Join-Path $startup 'QuickDrop Bridge.cmd')
& $launcher
Write-Host 'QuickDrop Bridge installed and started. Windows may ask once for private-network firewall access.'
