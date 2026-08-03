# W4 control experiment — run this from an ELEVATED PowerShell.
#
# Registers Microsoft's reference virtual camera media source, starts it, tries
# to read frames through the same consumer path our own vcam-host uses, then
# unregisters and cleans up.
#
# Result reading:
#   frames delivered        -> the fault is in OUR media source; the three known
#                              reference gaps are the search space.
#   0xC00D3EA2 on ReadSample -> environmental; no change to our source can help.
#
# Everything is written to control-result.log next to this script.

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $here 'control.exe'
$dll = Join-Path $here 'VirtualCameraMediaSource.dll'
$log = Join-Path $here 'control-result.log'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

$out = New-Object System.Collections.Generic.List[string]
function Say([string]$line) {
  Write-Host $line
  $out.Add($line)
}

Say "W4 reference-camera control experiment"
Say "elevated: $isAdmin   user: $($id.Name)"
Say ''

if (-not $isAdmin) {
  Say 'ABORT  not elevated. The Frame Server runs as NT AUTHORITY\LocalService and'
  Say '       cannot read HKCU, so the reference CLSID must go in HKLM.'
  Say '       Re-run this script from an Administrator PowerShell.'
  $out -join "`r`n" | Out-File -FilePath $log -Encoding utf8
  exit 2
}
foreach ($required in $exe, $dll) {
  if (-not (Test-Path -LiteralPath $required)) {
    Say "ABORT  missing $required"
    $out -join "`r`n" | Out-File -FilePath $log -Encoding utf8
    exit 2
  }
}

try {
  Say '--- 1. register the reference source under HKLM ---'
  & $exe register $dll 2>&1 | ForEach-Object { Say "  $_" }
  Say "  exit=$LASTEXITCODE"
  if ($LASTEXITCODE -ne 0) { throw 'registration failed' }
  Say ''

  Say '--- 2. create the virtual camera and read frames ---'
  # Runs elevated here so the whole experiment needs one approval. That does not
  # weaken the result: the Frame Server hosts the media source in its own
  # LocalService process either way, so whether the CONSUMER is elevated has no
  # bearing on whether MediaSource::Start is ever called.
  & $exe run 10 2>&1 | ForEach-Object { Say "  $_" }
  $runExit = $LASTEXITCODE
  Say "  exit=$runExit"
  Say ''

  Say '--- verdict ---'
  $text = $out -join "`n"
  if ($runExit -eq 0) {
    Say 'REFERENCE CAMERA STREAMS on this machine.'
    Say '=> The fault is in OUR media source, not the environment.'
    Say '   Search space: IMFSampleAllocatorControl,'
    Say '   MF_DEVICEMFT_SENSORPROFILE_COLLECTION, and the configuration PFN.'
  } elseif ($text -match '0xC00D3EA2') {
    Say 'REFERENCE CAMERA FAILS IDENTICALLY (0xC00D3EA2).'
    Say '=> The fault is environmental. No change to our media source can fix'
    Say '   this, and W4 should stay parked behind the OBS path.'
  } else {
    Say "REFERENCE CAMERA FAILED, but not with our signature (exit $runExit)."
    Say '=> Inconclusive; read the log above before drawing a conclusion.'
  }
} catch {
  Say "ERROR  $($_.Exception.Message)"
} finally {
  Say ''
  Say '--- 3. cleanup: unregister ---'
  & $exe unregister 2>&1 | ForEach-Object { Say "  $_" }
  $key = 'HKLM:\Software\Classes\CLSID\{7B89B92E-FE71-42D0-8A41-E137D06EA184}'
  Say "  HKLM key still present: $(Test-Path $key)"
  $out -join "`r`n" | Out-File -FilePath $log -Encoding utf8
  Say ''
  Say "log written to $log"
}
