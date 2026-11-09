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

$installRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'Twinscript'))
$expectedRoot = [IO.Path]::GetFullPath("$env:ProgramData\Twinscript")
if (-not $installRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing an unexpected native-camera removal target.'
}

# Remove registry entries directly rather than loading an installed DLL with an
# elevated token. This also repairs missing and versioned DLL installations.
function Remove-TwinscriptCameraInstallation([string]$installRoot) {
  $classes = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\CLSID'
  $filter = '{1F5A7C2E-8D64-4B93-9E11-3A6C5D8F27B4}'
  $category = "$classes\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance"
  $categoryKeys = @()
  if (Test-Path -LiteralPath $category) {
    $categoryKeys = @(Get-ChildItem -LiteralPath $category | Where-Object {
      $properties = Get-ItemProperty -LiteralPath $_.PSPath
      $_.PSChildName -eq $filter -or ($properties.PSObject.Properties['CLSID'] -and $properties.CLSID -eq $filter)
    })
  }
  # Category first: never leave an enumerated device pointing at a deleted server.
  foreach ($key in $categoryKeys) {
    Remove-Item -LiteralPath $key.PSPath -Recurse -Force
  }
  $registrationRoot = "$classes\$filter"
  $legacyRoot = "$classes\{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}"
  foreach ($key in @($registrationRoot, $legacyRoot)) {
    if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
  }
  foreach ($key in @($registrationRoot, $legacyRoot) + @($categoryKeys | ForEach-Object { $_.PSPath })) {
    if (Test-Path -LiteralPath $key) { throw 'Camera registration remains; preserving installed files.' }
  }
  if (Test-Path -LiteralPath $installRoot) {
    # Preflight before deleting anything: loaded filters must remain recoverable.
    # A race after this check still fails loudly; no deletion is reported as success.
    $handles = @()
    try {
      foreach ($file in Get-ChildItem -LiteralPath $installRoot -Recurse -File) {
        $handles += [IO.File]::Open($file.FullName, 'Open', 'Read', 'None')
      }
    } catch {
      throw 'Camera files are in use; close meeting clients and retry removal. Files preserved.'
    } finally {
      foreach ($handle in $handles) { $handle.Dispose() }
    }
    Remove-Item -LiteralPath $installRoot -Recurse -Force
  }
}

Remove-TwinscriptCameraInstallation $installRoot
Write-Output 'Native camera removed.'
