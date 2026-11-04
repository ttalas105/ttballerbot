$ErrorActionPreference = 'Stop'
$botRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeRoot = Join-Path $botRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$pidFile = Join-Path $runtimeRoot 'bot.pid'
if (Test-Path -LiteralPath $pidFile) {
    $oldId = [int](Get-Content -LiteralPath $pidFile)
    $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $oldId" -ErrorAction SilentlyContinue
    if ($oldProcess -and $oldProcess.CommandLine.Contains((Join-Path $botRoot 'dist\src\index.js'))) {
        Write-Output "ttballerbot is already running (PID $oldId)."
        exit 0
    }
}
$entry = Join-Path $botRoot 'dist\src\index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Build the bot first with npm run build.' }
$nodeExecutable = (Get-Command node).Source
$runner = Join-Path $PSScriptRoot 'run-background.ps1'
$taskName = 'ttballerbot-local'
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -and -not ($existingTask.Actions.Arguments -like ('*' + $runner + '*'))) { throw 'The task name belongs to another launcher; refusing to replace it.' }
if ($existingTask -and $existingTask.State -eq 'Running') { Write-Output 'ttballerbot launcher is already running.'; exit 0 }
$powershellExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershellExecutable -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $runner + '"') -WorkingDirectory $botRoot
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
# Demand-start only: no login/startup trigger, no stored password, no elevation.
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Description 'Local ttballerbot launcher with three automatic recovery attempts.' -Force | Out-Null
$stopFile = Join-Path $runtimeRoot 'bot.stop'
if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile }
Start-ScheduledTask -TaskName $taskName
$deadline = (Get-Date).AddSeconds(20)
do {
    if (Test-Path -LiteralPath $pidFile) {
        $botId = [int](Get-Content -LiteralPath $pidFile)
        $botProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $botId" -ErrorAction SilentlyContinue
        if ($botProcess -and $botProcess.CommandLine -and $botProcess.CommandLine.Contains($entry)) { Write-Output "Started ttballerbot (PID $botId) under Task Scheduler. Logs: $runtimeRoot"; exit 0 }
    }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
throw 'The launcher did not start the bot. Check .runtime/supervisor.log and Task Scheduler.'
