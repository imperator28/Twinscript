param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$CacheDirectory,
  [string]$LockPath
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($LockPath)) {
  $LockPath = Join-Path $PSScriptRoot "llama-windows-runtime-lock.json"
}

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-OrdinaryDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label must be a directory: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label cannot be a reparse point: $Path"
  }
}

function Assert-DirectoryTreeHasNoReparsePoints {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-OrdinaryDirectory -Path $Path -Label $Label
  $reparsePoints = @(Get-ChildItem -LiteralPath $Path -Force -Recurse | Where-Object {
    ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  })
  if ($reparsePoints.Count -gt 0) {
    throw "$Label contains a reparse point: $($reparsePoints[0].FullName)"
  }
}

function Resolve-FamilyDestination {
  param(
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$DirectoryName,
    [Parameter(Mandatory = $true)][string]$Family
  )

  if ($DirectoryName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw "Invalid $Family directory name in runtime lock: $DirectoryName"
  }
  $root = Get-FullPath $OutputRoot
  $candidate = Get-FullPath (Join-Path $root $DirectoryName)
  $separator = [System.IO.Path]::DirectorySeparatorChar
  $rootPrefix = if ($root.EndsWith($separator.ToString()) -or $root.EndsWith([System.IO.Path]::AltDirectorySeparatorChar.ToString())) {
    $root
  } else {
    $root + $separator
  }
  if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Family destination escapes the caller-provided output directory"
  }
  return $candidate
}

function Test-PathContains {
  param(
    [Parameter(Mandatory = $true)][string]$ParentPath,
    [Parameter(Mandatory = $true)][string]$ChildPath
  )

  $parent = Get-FullPath $ParentPath
  $child = Get-FullPath $ChildPath
  if ($parent -eq $child) {
    return $true
  }
  $separator = [System.IO.Path]::DirectorySeparatorChar
  $prefix = if ($parent.EndsWith($separator.ToString()) -or $parent.EndsWith([System.IO.Path]::AltDirectorySeparatorChar.ToString())) {
    $parent
  } else {
    $parent + $separator
  }
  return $child.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-CacheDoesNotOverlapDestination {
  param(
    [Parameter(Mandatory = $true)][string]$CacheRoot,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Family
  )

  if ((Test-PathContains -ParentPath $CacheRoot -ChildPath $Destination) -or (Test-PathContains -ParentPath $Destination -ChildPath $CacheRoot)) {
    throw "Cache directory overlaps managed runtime destination for ${Family}: $CacheRoot <-> $Destination"
  }
}

function Get-ArchiveFileName {
  param([Parameter(Mandatory = $true)][string]$Url)

  try {
    $uri = [System.Uri]$Url
  } catch {
    throw "Invalid archive URL: $Url"
  }
  if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com') {
    throw "Runtime archive must use an official HTTPS GitHub URL: $Url"
  }
  $name = [System.IO.Path]::GetFileName($uri.AbsolutePath)
  if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$') {
    throw "Invalid archive file name: $name"
  }
  return $name
}

function Assert-ArchiveHash {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedHash
  )

  $actual = Get-Sha256 -Path $Path
  if ($actual -ne $ExpectedHash.ToLowerInvariant()) {
    throw "SHA-256 mismatch for archive: $Path"
  }
}

function Get-CachedArchive {
  param(
    [Parameter(Mandatory = $true)]$Archive,
    [Parameter(Mandatory = $true)][string]$CacheRoot
  )

  if ($Archive.sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw "Invalid archive SHA-256 in runtime lock: $($Archive.sha256)"
  }
  $archiveName = Get-ArchiveFileName $Archive.url
  $archivePath = Join-Path $CacheRoot $archiveName
  if (Test-Path -LiteralPath $archivePath) {
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
      throw "Archive cache path is not a file: $archivePath"
    }
  } else {
    $partialPath = Join-Path $CacheRoot (".$archiveName.download-" + [System.Guid]::NewGuid().ToString("N"))
    try {
      Invoke-WebRequest -Uri $Archive.url -OutFile $partialPath -UseBasicParsing
      Assert-ArchiveHash -Path $partialPath -ExpectedHash $Archive.sha256
      Move-Item -LiteralPath $partialPath -Destination $archivePath
    } finally {
      if (Test-Path -LiteralPath $partialPath -PathType Leaf) {
        Remove-Item -LiteralPath $partialPath -Force
      }
    }
  }
  Assert-ArchiveHash -Path $archivePath -ExpectedHash $Archive.sha256
  return $archivePath
}

function Assert-ArchiveEntriesAreSafe {
  param([Parameter(Mandatory = $true)][string]$ArchivePath)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($entry in $zip.Entries) {
      $entryPath = $entry.FullName
      if ($entryPath -match '(^|[\\/])\.\.([\\/]|$)' -or $entryPath -match '^[\\/]' -or $entryPath -match '^[A-Za-z]:') {
        throw "Archive contains an unsafe path: $entryPath"
      }
    }
  } finally {
    $zip.Dispose()
  }
}

function Get-RuntimeInventory {
  param([Parameter(Mandatory = $true)][string]$Directory)

  $root = Get-FullPath $Directory
  $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
  return @(
    Get-ChildItem -LiteralPath $root -Recurse -File -Force |
      Where-Object { $_.Name -ne 'runtime-family.json' } |
      Sort-Object FullName |
      ForEach-Object {
        $relativePath = $_.FullName.Substring($prefix.Length).Replace('\', '/')
        [ordered]@{
          path = $relativePath
          size = $_.Length
          sha256 = Get-Sha256 -Path $_.FullName
        }
      }
  )
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $bytes = $algorithm.ComputeHash($stream)
    return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
  } finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

function Assert-RuntimeFamilyLayout {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Family
  )

  Assert-DirectoryTreeHasNoReparsePoints -Path $Directory -Label "$Family staging directory"
  $serverPath = Join-Path $Directory 'llama-server.exe'
  if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    $nestedServer = @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter 'llama-server.exe' -Force)
    if ($nestedServer.Count -gt 0) {
      throw "$Family runtime has a nested runtime-family directory: $($nestedServer[0].FullName)"
    }
    throw "$Family runtime is missing llama-server.exe"
  }
  $pythonExecutables = @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Force | Where-Object {
    $_.Name -match '^python.*\.exe$'
  })
  if ($pythonExecutables.Count -gt 0) {
    throw "$Family runtime contains a Python executable: $($pythonExecutables[0].FullName)"
  }
  $nestedFamilies = @(Get-ChildItem -LiteralPath $Directory -Recurse -Directory -Force | Where-Object {
    $_.Name -in @('cpu', 'cuda')
  })
  if ($nestedFamilies.Count -gt 0) {
    throw "$Family runtime contains a nested runtime-family directory: $($nestedFamilies[0].FullName)"
  }
  $dllFiles = @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Force | Where-Object {
    $_.Extension -ieq '.dll'
  })
  if ($dllFiles.Count -eq 0) {
    throw "$Family runtime does not contain any DLL files"
  }
}

function New-StagingDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$Family
  )

  $path = Join-Path $OutputRoot (".llama-" + $Family + "-stage-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $path | Out-Null
  return (Get-FullPath $path)
}

function Install-StagedRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$StageDirectory,
    [Parameter(Mandatory = $true)][string]$Family
  )

  $backup = $null
  if (Test-Path -LiteralPath $Destination) {
    Assert-DirectoryTreeHasNoReparsePoints -Path $Destination -Label "$Family destination"
    $backup = Join-Path (Split-Path -Parent $Destination) (".llama-" + $Family + "-backup-" + [System.Guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $Destination -Destination $backup
  }
  try {
    Move-Item -LiteralPath $StageDirectory -Destination $Destination
  } catch {
    if ($null -ne $backup -and (Test-Path -LiteralPath $backup)) {
      Move-Item -LiteralPath $backup -Destination $Destination
    }
    throw
  }
  return $backup
}

if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
  throw "Runtime lock file does not exist: $LockPath"
}
$lock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
if ($lock.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace($lock.revision)) {
  throw "Unsupported or invalid llama Windows runtime lock"
}
foreach ($familyName in @('cpu', 'cuda')) {
  $familyConfig = $lock.$familyName
  if ($null -eq $familyConfig -or $familyConfig.directory -ne $familyName -or @($familyConfig.archives).Count -eq 0) {
    throw "Invalid $familyName runtime family in lock"
  }
}
if (@($lock.cpu.archives).Count -ne 1 -or @($lock.cuda.archives).Count -ne 2) {
  throw "The runtime lock must declare one CPU archive and two CUDA archives"
}

$outputRoot = Get-FullPath $OutputDirectory
$cacheRoot = Get-FullPath $CacheDirectory
$cpuDestination = Resolve-FamilyDestination -OutputRoot $outputRoot -DirectoryName $lock.cpu.directory -Family 'cpu'
$cudaDestination = Resolve-FamilyDestination -OutputRoot $outputRoot -DirectoryName $lock.cuda.directory -Family 'cuda'
if ($cpuDestination -eq $cudaDestination) {
  throw 'CPU and CUDA runtime destinations must be distinct'
}
Assert-CacheDoesNotOverlapDestination -CacheRoot $cacheRoot -Destination $cpuDestination -Family 'cpu'
Assert-CacheDoesNotOverlapDestination -CacheRoot $cacheRoot -Destination $cudaDestination -Family 'cuda'

if (-not (Test-Path -LiteralPath $outputRoot)) {
  New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
}
Assert-OrdinaryDirectory -Path $outputRoot -Label 'Output directory'
if (-not (Test-Path -LiteralPath $cacheRoot)) {
  New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
}
Assert-OrdinaryDirectory -Path $cacheRoot -Label 'Cache directory'

$archivePaths = @{}
foreach ($familyName in @('cpu', 'cuda')) {
  foreach ($archive in @($lock.$familyName.archives)) {
    $archiveName = Get-ArchiveFileName $archive.url
    if ($archivePaths.ContainsKey($archiveName)) {
      throw "Duplicate archive file name in runtime lock: $archiveName"
    }
    $archivePaths[$archiveName] = Get-CachedArchive -Archive $archive -CacheRoot $cacheRoot
  }
}

$prepared = @()
$installed = @()
try {
  foreach ($familyName in @('cpu', 'cuda')) {
    $familyConfig = $lock.$familyName
    $stageDirectory = New-StagingDirectory -OutputRoot $outputRoot -Family $familyName
    $runtime = [pscustomobject]@{
      family = $familyName
      destination = if ($familyName -eq 'cpu') { $cpuDestination } else { $cudaDestination }
      stageDirectory = $stageDirectory
    }
    $prepared += $runtime
    foreach ($archive in @($familyConfig.archives)) {
      $archivePath = $archivePaths[(Get-ArchiveFileName $archive.url)]
      Assert-ArchiveEntriesAreSafe -ArchivePath $archivePath
      Expand-Archive -LiteralPath $archivePath -DestinationPath $stageDirectory -Force
    }
    Assert-RuntimeFamilyLayout -Directory $stageDirectory -Family $familyName
    $manifest = [ordered]@{
      schemaVersion = 1
      revision = $lock.revision
      family = $familyName
      archives = @($familyConfig.archives)
      inventory = @(Get-RuntimeInventory -Directory $stageDirectory)
    }
    $manifestPath = Join-Path $stageDirectory 'runtime-family.json'
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  }

  foreach ($runtime in $prepared) {
    $backup = Install-StagedRuntime -Destination $runtime.destination -StageDirectory $runtime.stageDirectory -Family $runtime.family
    $installed += [pscustomobject]@{
      destination = $runtime.destination
      backup = $backup
    }
    # This test-only process boundary permits deterministic rollback coverage.
    # It requires both values, so ordinary production environments cannot
    # activate it by setting a family name alone.
    if ($env:LLAMA_RUNTIME_STAGE_TEST_MODE -eq 'llama-runtime-fixture-test-only' -and $env:LLAMA_RUNTIME_STAGE_TEST_FAIL_FAMILY -eq $runtime.family) {
      throw "Simulated installation failure for $($runtime.family)"
    }
  }
} catch {
  for ($index = $installed.Count - 1; $index -ge 0; $index--) {
    $runtime = $installed[$index]
    if (Test-Path -LiteralPath $runtime.destination) {
      Assert-DirectoryTreeHasNoReparsePoints -Path $runtime.destination -Label 'New runtime destination'
      Remove-Item -LiteralPath $runtime.destination -Recurse -Force
    }
    if ($null -ne $runtime.backup -and (Test-Path -LiteralPath $runtime.backup)) {
      Move-Item -LiteralPath $runtime.backup -Destination $runtime.destination
    }
  }
  throw
} finally {
  foreach ($runtime in $prepared) {
    if (Test-Path -LiteralPath $runtime.stageDirectory) {
      Assert-DirectoryTreeHasNoReparsePoints -Path $runtime.stageDirectory -Label 'Runtime staging directory'
      Remove-Item -LiteralPath $runtime.stageDirectory -Recurse -Force
    }
  }
}

foreach ($runtime in $installed) {
  if ($null -ne $runtime.backup -and (Test-Path -LiteralPath $runtime.backup)) {
    Assert-DirectoryTreeHasNoReparsePoints -Path $runtime.backup -Label 'Runtime backup directory'
    Remove-Item -LiteralPath $runtime.backup -Recurse -Force
  }
}

Write-Host "Staged llama.cpp $($lock.revision) CPU and CUDA runtimes into $outputRoot"
