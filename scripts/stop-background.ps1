$ErrorActionPreference = 'Stop'
$botRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pidFile = Join-Path $botRoot '.runtime\bot.pid'
$runtimeRoot = Join-Path $botRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Set-Content -LiteralPath (Join-Path $runtimeRoot 'bot.stop') -Value 'intentional stop'
$task = Get-ScheduledTask -TaskName 'ttballerbot-local' -ErrorAction SilentlyContinue
$runner = Join-Path $PSScriptRoot 'run-background.ps1'
if ($task -and ($task.Actions.Arguments -like ('*' + $runner + '*'))) { Stop-ScheduledTask -TaskName 'ttballerbot-local' }
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No background bot PID was recorded.'; exit 0 }
$botPid = [int](Get-Content -LiteralPath $pidFile)
$botProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $botPid" -ErrorAction SilentlyContinue
$entry = Join-Path $botRoot 'dist\src\index.js'
if ($botProcess) {
    if (-not $botProcess.CommandLine.Contains($entry)) { throw 'That PID belongs to another program; refusing to stop it.' }
    # Stop only the verified bot's process tree, including its audio subprocesses.
    & taskkill.exe /PID $botPid /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the bot process tree.' }
    Write-Output 'Stopped ttballerbot.'
} else { Write-Output 'ttballerbot is not running.' }
Remove-Item -LiteralPath $pidFile
