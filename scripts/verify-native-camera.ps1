[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$InstalledConsumer
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nativeRoot = Join-Path $repoRoot 'native\camera-companion'
$freshBuild = -not $SkipBuild
if ($freshBuild) {
  $tempRoot = [IO.Path]::GetFullPath($env:TEMP)
  $buildRoot = Join-Path $tempRoot ('bilingual-meeting-w4-native-' + [Guid]::NewGuid().ToString('N'))
} else {
  $buildRoot = Join-Path $nativeRoot 'build'
}
$releaseRoot = Join-Path $buildRoot 'Release'
$nativeHost = Join-Path $releaseRoot 'vcam-host.exe'
$mappedCheck = Join-Path $releaseRoot 'mapped-frame-reader-check.exe'

Push-Location $repoRoot
try {
  if (-not $SkipBuild) {
    & cmake.exe -S $nativeRoot -B $buildRoot -A x64
    if ($LASTEXITCODE -ne 0) { throw "Native configure failed ($LASTEXITCODE)." }
    & cmake.exe --build $buildRoot --config Release
    if ($LASTEXITCODE -ne 0) { throw "Native build failed ($LASTEXITCODE)." }
  }

  & node.exe --test electron/captions/camera-frame-transport.test.cjs electron/captions/camera-region-native-integration.test.cjs electron/captions/native-camera-source-contract.test.cjs electron/captions/native-camera-supervisor.test.cjs
  if ($LASTEXITCODE -ne 0) { throw "Native camera focused tests failed ($LASTEXITCODE)." }

  & $mappedCheck
  if ($LASTEXITCODE -ne 0) { throw "Mapped region check failed ($LASTEXITCODE)." }

  & $nativeHost register
  if ($LASTEXITCODE -ne 0) { throw "Per-user source registration failed ($LASTEXITCODE)." }
  try {
    $driveTimer = [Diagnostics.Stopwatch]::StartNew()
    & $nativeHost drive 20
    $driveTimer.Stop()
    if ($LASTEXITCODE -ne 0) { throw "Media source drive failed ($LASTEXITCODE)." }
    if ($driveTimer.Elapsed.TotalSeconds -lt 1.0) {
      throw "Media source produced 20 nominal 15 fps frames too quickly ($($driveTimer.Elapsed.TotalSeconds)s)."
    }
  } finally {
    & $nativeHost unregister | Out-Null
  }

  if ($InstalledConsumer) {
    $installedHost = Join-Path $env:ProgramData 'Bilingual Meeting Captions\bin\vcam-host.exe'
    if (-not (Test-Path -LiteralPath $installedHost -PathType Leaf)) {
      throw 'Install the native camera from Settings before the installed-consumer check.'
    }
    & $installedHost status-machine
    if ($LASTEXITCODE -ne 0) { throw 'Machine registration is missing or points to another build.' }
    Write-Output 'Keep the app in Virtual camera mode while the separate consumer opens it.'
    & $installedHost consume 30
    if ($LASTEXITCODE -ne 0) { throw "Separate installed consumer failed ($LASTEXITCODE)." }
  } else {
    Write-Output 'PENDING MANUAL: approve Install native camera, select Virtual camera, then rerun with -InstalledConsumer.'
  }
} finally {
  Pop-Location
  if ($freshBuild) {
    $resolvedBuild = [IO.Path]::GetFullPath($buildRoot)
    $resolvedTemp = [IO.Path]::GetFullPath($tempRoot).TrimEnd('\') + '\'
    if (-not $resolvedBuild.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFileName($resolvedBuild)).StartsWith('bilingual-meeting-w4-native-', [StringComparison]::Ordinal)) {
      throw 'Refusing to remove an unexpected native verification directory.'
    }
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force -ErrorAction SilentlyContinue
  }
}
