[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDirectory,
  [switch]$Elevated,
  [string]$UserSid
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $Elevated) {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -SourceDirectory "{1}" -Elevated -UserSid "{2}"' -f $PSCommandPath, $SourceDirectory, $currentSid
  try {
    $process = Start-Process -FilePath $powershell -ArgumentList $arguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden
    exit $process.ExitCode
  } catch [System.ComponentModel.Win32Exception] {
    if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }
    throw
  }
}

if (-not (Test-Administrator)) {
  throw 'Native camera registration requires administrator approval.'
}
try {
  # Microsoft-account identities use the S-1-12 authority instead of the
  # traditional S-1-5 authority. Let Windows validate the SID structure so
  # both account types are accepted without weakening the ACL target.
  [void][Security.Principal.SecurityIdentifier]::new($UserSid)
} catch {
  throw 'The requesting Windows user SID is invalid.'
}

$sourceRoot = [IO.Path]::GetFullPath($SourceDirectory)
$sourceHost = Join-Path $sourceRoot 'vcam-host.exe'
$sourceDll = Join-Path $sourceRoot 'bilingual-vcam-source.dll'
foreach ($source in @($sourceHost, $sourceDll)) {
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Native camera resource is missing: $source"
  }
}

$installRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Bilingual Meeting Captions'))
$expectedRoot = [IO.Path]::GetFullPath("$env:ProgramData\Bilingual Meeting Captions")
if (-not $installRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing an unexpected native-camera install target.'
}
$binaryRoot = Join-Path $installRoot 'bin'
New-Item -ItemType Directory -Path $binaryRoot -Force | Out-Null
$runtimeRoot = Join-Path $installRoot 'runtime'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$logRoot = Join-Path $installRoot 'logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

# Keep the HKLM-registered binaries administrator-owned. Granting Modify on the
# parent would include delete-child rights and let a standard user replace the
# COM DLL despite a stricter child ACL. Well-known SID syntax avoids failures on
# localized Windows installations.
& icacls.exe $installRoot /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*${UserSid}:(OI)(CI)RX" "*S-1-5-19:(OI)(CI)RX" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not secure native-camera install directory ($LASTEXITCODE)." }
& icacls.exe $binaryRoot /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*${UserSid}:(OI)(CI)RX" "*S-1-5-19:(OI)(CI)RX" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not secure native-camera binary directory ($LASTEXITCODE)." }
& icacls.exe $runtimeRoot /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*${UserSid}:(OI)(CI)M" "*S-1-5-19:(OI)(CI)R" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not secure native-camera runtime directory ($LASTEXITCODE)." }
& icacls.exe $logRoot /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*${UserSid}:(OI)(CI)M" "*S-1-5-19:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not secure native-camera log directory ($LASTEXITCODE)." }

# Never execute the prior installed host during Repair: an install made by an
# older permissive build may have been replaced. Remove only this product's
# exact machine registration before copying the replacement into the secured
# binary directory.
$registrationRoot = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\CLSID\{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}'
if (Test-Path -LiteralPath $registrationRoot) {
  Remove-Item -LiteralPath $registrationRoot -Recurse -Force
}
$installedHost = Join-Path $binaryRoot 'vcam-host.exe'
Copy-Item -LiteralPath $sourceHost -Destination $installedHost -Force
Copy-Item -LiteralPath $sourceDll -Destination (Join-Path $binaryRoot 'bilingual-vcam-source.dll') -Force

& $installedHost register-machine
if ($LASTEXITCODE -ne 0) {
  throw "Native camera COM registration failed ($LASTEXITCODE)."
}
& $installedHost status-machine
if ($LASTEXITCODE -ne 0) {
  throw "Native camera registration verification failed ($LASTEXITCODE)."
}

Write-Output "Native camera installed at $installRoot"
