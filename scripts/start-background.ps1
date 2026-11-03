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
$process = Start-Process -FilePath $nodeExecutable -ArgumentList @('"' + $entry + '"') -WorkingDirectory $botRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'bot.log') -RedirectStandardError (Join-Path $runtimeRoot 'bot-error.log')
Set-Content -LiteralPath $pidFile -Value $process.Id
Write-Output "Started ttballerbot (PID $($process.Id)). Logs: $runtimeRoot"
