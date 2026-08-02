[CmdletBinding()]
param(
  [switch]$Elevated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $Elevated) {
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Elevated' -f $PSCommandPath
  try {
    $process = Start-Process -FilePath $powershell -ArgumentList $arguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden
    exit $process.ExitCode
  } catch [System.ComponentModel.Win32Exception] {
    if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }
    throw
  }
}

if (-not (Test-Administrator)) {
  throw 'Native camera removal requires administrator approval.'
}

$installRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Bilingual Meeting Captions'))
$expectedRoot = [IO.Path]::GetFullPath("$env:ProgramData\Bilingual Meeting Captions")
if (-not $installRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing an unexpected native-camera removal target.'
}

$registrationRoot = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\CLSID\{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}'
if (Test-Path -LiteralPath $registrationRoot) {
  Remove-Item -LiteralPath $registrationRoot -Recurse -Force
}

if (Test-Path -LiteralPath $installRoot) {
  Remove-Item -LiteralPath $installRoot -Recurse -Force
}
Write-Output 'Native camera removed.'
