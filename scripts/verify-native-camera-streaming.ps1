<#
.SYNOPSIS
End-to-end check that the Windows Frame Server actually streams our virtual
camera. Must be run from an ELEVATED PowerShell.

.DESCRIPTION
HKLM registration is required and needs administrator: the Frame Server runs as
NT AUTHORITY\LocalService and cannot read HKCU.

This is the check that distinguishes "the media source works" from "the camera
works". `vcam-host drive` exercises the source in-process and passed for weeks
while the real camera delivered nothing, because in-process activation never
involves the Frame Server at all.

Registers under HKLM, creates the virtual camera, starts it, reads frames the way
a meeting app does (enumerate capture devices, match the friendly name, source
reader), then unregisters and confirms the key is gone.

Mirrors the harness that proved Microsoft's reference camera streams on this
machine, so the two results are directly comparable.

.PARAMETER Frames
How many frames to require.

.PARAMETER ReleaseDir
Directory holding vcam-host.exe and twinscript-vcam-source.dll.
#>
[CmdletBinding()]
param(
  [int]$Frames = 15,
  [string]$ReleaseDir = 'native/camera-companion/build/Release'
)

$ErrorActionPreference = 'Continue'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Output 'W4 native camera streaming check'
Write-Output "elevated: $isAdmin   user: $($id.Name)"
Write-Output ''

if (-not $isAdmin) {
  Write-Output 'ABORT  not elevated. The Frame Server runs as NT AUTHORITY\LocalService'
  Write-Output '       and cannot read HKCU, so the CLSID must be registered in HKLM.'
  Write-Output '       Re-run from an Administrator PowerShell.'
  exit 2
}

$host_exe = Join-Path $ReleaseDir 'vcam-host.exe'
if (-not (Test-Path -LiteralPath $host_exe)) {
  Write-Output "ABORT  $host_exe not found. Build first:"
  Write-Output '       cmake --build native/camera-companion/build --config Release'
  exit 2
}

$registered = $false
try {
  Write-Output '--- 1. register under HKLM ---'
  & $host_exe register-machine
  if ($LASTEXITCODE -ne 0) { throw 'HKLM registration failed' }
  $registered = $true
  Write-Output ''

  Write-Output '--- 2. status ---'
  & $host_exe status-machine
  Write-Output ''

  Write-Output '--- 3. create the camera and read frames through the Frame Server ---'
  & $host_exe selftest $Frames
  $streamExit = $LASTEXITCODE
  Write-Output ''

  Write-Output '--- verdict ---'
  if ($streamExit -eq 0) {
    Write-Output "PASS  the Frame Server streamed $Frames frames from our source."
    Write-Output '      W4 blank feed is resolved.'
  } else {
    Write-Output "FAIL  streaming still broken (exit $streamExit)."
    Write-Output '      If ReadSample reported 0xC00D3EA2 the source is still being'
    Write-Output '      abandoned after activation. Remaining known differences from'
    Write-Output '      the reference: MF_DEVICEMFT_SENSORPROFILE_COLLECTION and'
    Write-Output '      MF_VIRTUALCAMERA_CONFIGURATION_APP_PACKAGE_FAMILY_NAME.'
  }
} catch {
  Write-Output "ERROR  $($_.Exception.Message)"
} finally {
  if ($registered) {
    Write-Output ''
    Write-Output '--- 4. cleanup ---'
    & $host_exe unregister-machine
    $key = 'HKLM:\Software\Classes\CLSID\{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}'
    Write-Output "  HKLM key still present: $(Test-Path $key)"
  }
}
