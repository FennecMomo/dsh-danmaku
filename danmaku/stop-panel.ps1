<#
.SYNOPSIS
    Stop the danmaku overlay panel.

.DESCRIPTION
    The overlay has no close button - it is a plain display surface with no chrome,
    on purpose - so stopping it has to be possible from outside it. This is that
    path, and it is also what the DSH-side button calls.

    IT ASKS, IT DOES NOT KILL. That is forced by the environment and it is also the
    better design.

    Two out-of-band kills were tried and both are refused in the harness host's
    execution context:

      * enumerating processes with Get-CimInstance - "could not enumerate: 拒绝访问"
      * killing a known pid with taskkill - "ERROR: Access denied"

    So the panel is asked to quit instead: this writes a stop-request file, and the
    panel's own loop notices it, destroys its window, closes the SSE socket, and
    exits. That needs no permission at all, and it is strictly better than a kill -
    the window goes away cleanly and `--status` reports "stopped" rather than a
    crash or a stale file.

    A kill remains as a last resort, because a panel that is wedged should still be
    stoppable. It runs only if the request was not honoured, and it is expected to
    fail in the host context; when it does, the failure is reported rather than
    swallowed, since a stop that silently does nothing is the bug this file spent
    the longest fixing.

    Exit codes: 0 stopped, 1 nothing was running, 2 it was found but would not stop.
#>
[CmdletBinding()]
param([int]$TimeoutSeconds = 8)

$ErrorActionPreference = 'Stop'

$statusPath = Join-Path $PSScriptRoot '.panel-status.json'
$stopPath = Join-Path $PSScriptRoot '.panel-stop'
$donePath = Join-Path $PSScriptRoot '.panel-done.json'

function Get-PanelPid {
    if (-not (Test-Path -LiteralPath $statusPath)) { return 0 }
    try {
        $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return 0
    }
    $value = 0
    if ([int]::TryParse([string]$status.pid, [ref]$value) -and $value -gt 0) { return $value }
    return 0
}

function Test-Alive([int]$ProcessId) {
    if ($ProcessId -le 0) { return $false }
    try {
        $null = Get-Process -Id $ProcessId -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

$targetPid = Get-PanelPid
if ($targetPid -eq 0 -and -not (Test-Path -LiteralPath $statusPath)) {
    Write-Output 'no danmaku panel is running'
    if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue }
    exit 1
}

if (-not (Test-Alive $targetPid)) {
    Write-Output "pid=$targetPid is already gone"
    foreach ($p in @($statusPath, $donePath)) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    }
    exit 1
}

# The request itself. The panel polls for this file every few seconds.
try {
    Set-Content -LiteralPath $stopPath -Value (Get-Date -Format o) -Encoding UTF8 -Force -ErrorAction Stop
} catch {
    Write-Output "could not write the stop request: $($_.Exception.Message)"
    exit 2
}

$waited = 0
while ($waited -lt $TimeoutSeconds -and (Test-Alive $targetPid)) {
    Start-Sleep -Milliseconds 250
    $waited += 0.25
}

if (-not (Test-Alive $targetPid)) {
    Write-Output "stopped danmaku panel pid=$targetPid after ${waited}s (asked it to quit)"
    exit 0
}

# Last resort. Expected to fail when the caller cannot manage processes; reported
# either way, because a stop that quietly does nothing is worse than an error.
Write-Output "pid=$targetPid did not honour the stop request within ${TimeoutSeconds}s; trying to kill it"
try {
    $null = & taskkill.exe /PID $targetPid /T /F 2>&1
} catch {
    Write-Output "taskkill failed: $($_.Exception.Message)"
}
Start-Sleep -Milliseconds 400

if (Test-Alive $targetPid) {
    Write-Output "could not stop pid=$targetPid"
    exit 2
}

Write-Output "stopped danmaku panel pid=$targetPid (killed)"
exit 0
