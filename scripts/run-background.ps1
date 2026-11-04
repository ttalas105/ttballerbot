$ErrorActionPreference = 'Stop'
$botRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeRoot = Join-Path $botRoot '.runtime'
$stopFile = Join-Path $runtimeRoot 'bot.stop'
if (Test-Path -LiteralPath $stopFile) { exit 0 }
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$entry = Join-Path $botRoot 'dist\src\index.js'
$pidFile = Join-Path $runtimeRoot 'bot.pid'
$supervisorLog = Join-Path $runtimeRoot 'supervisor.log'
if (Test-Path -LiteralPath $pidFile) {
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $([int](Get-Content -LiteralPath $pidFile))" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -and $existing.CommandLine.Contains($entry)) { exit 0 }
}
foreach ($name in @('bot.log', 'bot-error.log')) {
    $logPath = Join-Path $runtimeRoot $name
    if (Test-Path -LiteralPath $logPath) { Copy-Item -LiteralPath $logPath -Destination (Join-Path $runtimeRoot ('previous-' + $name)) -Force }
}
try {
    $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
    $bot = Start-Process -FilePath $nodeExecutable -ArgumentList @('"' + $entry + '"') -WorkingDirectory $botRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'bot.log') -RedirectStandardError (Join-Path $runtimeRoot 'bot-error.log')
    Set-Content -LiteralPath $pidFile -Value $bot.Id
    Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) started pid=$($bot.Id)"
    $bot.WaitForExit()
    Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) stopped pid=$($bot.Id) exitCode=$($bot.ExitCode)"
} catch {
    Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) launcher failed: $($_.Exception.GetType().Name)"
}
if (Test-Path -LiteralPath $stopFile) { exit 0 }
# Task Scheduler retries unexpected exits; intentional stops create bot.stop first.
exit 1
