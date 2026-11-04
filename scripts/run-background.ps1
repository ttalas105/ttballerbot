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
for ($attempt = 0; $attempt -le 3; $attempt++) {
    if (Test-Path -LiteralPath $stopFile) { exit 0 }
    try {
        foreach ($name in @('bot.log', 'bot-error.log')) {
            $logPath = Join-Path $runtimeRoot $name
            if (Test-Path -LiteralPath $logPath) { Copy-Item -LiteralPath $logPath -Destination (Join-Path $runtimeRoot ('previous-' + $name)) -Force }
        }
        $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
        $bot = Start-Process -FilePath $nodeExecutable -ArgumentList @('"' + $entry + '"') -WorkingDirectory $botRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'bot.log') -RedirectStandardError (Join-Path $runtimeRoot 'bot-error.log')
        Set-Content -LiteralPath $pidFile -Value $bot.Id
        Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) started pid=$($bot.Id) recovery=$attempt"
        $bot.WaitForExit()
        Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) stopped pid=$($bot.Id)"
    } catch {
        Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) launcher failed: $($_.Exception.GetType().Name)"
    }
    if (Test-Path -LiteralPath $stopFile) { exit 0 }
    if ($attempt -eq 3) { break }
    Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) restarting in 5 seconds"
    for ($second = 0; $second -lt 5; $second++) {
        if (Test-Path -LiteralPath $stopFile) { exit 0 }
        Start-Sleep -Seconds 1
    }
}
Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) recovery attempts exhausted"
exit 1
