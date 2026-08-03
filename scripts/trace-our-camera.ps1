<#
.SYNOPSIS
Capture the Frame Server's call sequence into OUR media source, in the same form
as the reference trace, so the two can be diffed. Run ELEVATED.

.DESCRIPTION
The reference camera streams in Teams; ours is black. Their interface sets are
now identical (verified by direct QueryInterface probe), so the difference is in
the call flow or the data, not in which interfaces exist.

The working sequence, captured from the instrumented reference:

    activate
    GetSourceAttributes
    GetService
    CreatePresentationDescriptor
    GetStreamAttributes
    GetSourceAttributes  x2
    GetService
    KsProperty
    KsEvent
    Shutdown

Our source now logs every one of those entry points, so this run shows exactly
which of them we reach and where it stops. Whatever the last call is, that is the
fault - no more inference.

The camera is held open and NOT consumed locally: an in-process consumer bypasses
the Frame Server, which is the mistake that made every earlier harness pass while
meeting clients showed black.
#>
[CmdletBinding()]
param([string]$ReleaseDir)

$ErrorActionPreference = 'Continue'

if (-not $ReleaseDir) {
  $ReleaseDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'native\camera-companion\build\Release'
}

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'ABORT  not elevated. HKLM registration is required.'
  exit 2
}

$hostExe = Join-Path $ReleaseDir 'vcam-host.exe'
if (-not (Test-Path -LiteralPath $hostExe)) {
  Write-Output "ABORT  not found: $hostExe"
  exit 2
}

$log = 'C:\ProgramData\Twinscript\logs\vcam-source.log'
# Mark the start so only this run's lines are reported. The log is appended to by
# every process that loads the DLL, including past runs.
$marker = "===== TRACE RUN $([DateTime]::Now.ToString('HH:mm:ss.fff')) ====="
if (Test-Path -LiteralPath $log) { Add-Content -LiteralPath $log -Value $marker }

$registered = $false
try {
  Write-Output '--- register our freshly instrumented source ---'
  & $hostExe register-machine
  if ($LASTEXITCODE -ne 0) { throw 'HKLM registration failed' }
  $registered = $true
  Write-Output ''
  Write-Output '>>> Select "Twinscript" in TEAMS now (it will be black - that is expected).'
  Write-Output '>>> Give it ~10 seconds, then come back and press Enter.'
  Write-Output ''
  $env:TWINSCRIPT_VCAM_SYNTHETIC = '1'
  & $hostExe camera 0
} catch {
  Write-Output "ERROR  $($_.Exception.Message)"
} finally {
  if ($registered) {
    Write-Output ''
    Write-Output '--- unregister ---'
    & $hostExe unregister-machine
    $inproc = 'HKLM:\Software\Classes\CLSID\{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}\InprocServer32'
    if (Test-Path $inproc) {
      Write-Output "  CLEANUP FAILED - remove with:  & '$hostExe' unregister-machine"
    } else {
      Write-Output '  ok    HKLM registration removed'
    }
  }
}

Write-Output ''
Write-Output '=================== OUR CALL SEQUENCE ==================='
if (Test-Path -LiteralPath $log) {
  $all = Get-Content -LiteralPath $log
  $index = [Array]::LastIndexOf($all, $marker)
  $lines = if ($index -ge 0) { $all[($index + 1)..($all.Count - 1)] } else { $all }

  $previous = ''
  $repeats = 0
  foreach ($line in $lines) {
    # Strip the timestamp/pid/host prefix; only the call matters for the diff.
    $call = ($line -replace '^\S+\s+pid=\d+\s+host=\S.*?\|\s*', '').Trim()
    if ($call -eq '') { continue }
    if ($call -eq $previous) { $repeats++; continue }
    if ($repeats -gt 0) { Write-Output "      ... x$repeats more"; $repeats = 0 }
    Write-Output "  $call"
    $previous = $call
  }
  if ($repeats -gt 0) { Write-Output "      ... x$repeats more" }
} else {
  Write-Output "  no log at $log"
}
