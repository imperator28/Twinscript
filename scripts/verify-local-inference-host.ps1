param(
  [Parameter(Mandatory = $true)][string]$HostDirectory,
  [switch]$CpuOnly
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path $HostDirectory).Path
$manifestPath = Join-Path $root "runtime-manifest.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 2) { throw "Runtime manifest must use schema 2" }
if (-not $manifest.runtimeFamilies.cpu) { throw "CPU runtime family metadata is missing" }
if (-not $CpuOnly -and -not $manifest.runtimeFamilies.cuda) { throw "CUDA runtime family metadata is missing" }

$inventory = @{}
foreach ($entry in $manifest.files) {
  if ($entry.path -notmatch '^[^\\/]+(?:/[^\\/]+)*$' -or $entry.path -match '(^|/)\.\.?(/|$)') {
    throw "Unsafe runtime path: $($entry.path)"
  }
  if ($inventory.ContainsKey($entry.path)) { throw "Duplicate runtime path: $($entry.path)" }
  $inventory[$entry.path] = $true
  if ($entry.path -match "(^|/)(python|python3)(\.exe)?$") {
    throw "Python runtime is not permitted in the native host artifact"
  }
  $file = Join-Path $root $entry.path
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing runtime file: $($entry.path)" }
  if ((Get-Item -LiteralPath $file).Length -ne $entry.size) { throw "Size mismatch: $($entry.path)" }
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $entry.sha256) { throw "Hash mismatch: $($entry.path)" }
}

$familyNames = @("cpu")
if (-not $CpuOnly) { $familyNames += "cuda" }
$revision = $manifest.runtimeFamilies.cpu.revision
if ([string]::IsNullOrWhiteSpace($revision)) { throw "CPU runtime revision is missing" }
foreach ($familyName in $familyNames) {
  $family = $manifest.runtimeFamilies.$familyName
  $expectedEntryPoint = "llama/$familyName/llama-server.exe"
  if ($family.entryPoint -ne $expectedEntryPoint) {
    throw "$($familyName.ToUpperInvariant()) entry point must be $expectedEntryPoint"
  }
  if ($family.revision -ne $revision) { throw "CPU and CUDA runtimes must use the same pinned revision" }
  if (-not ($family.files -contains $expectedEntryPoint)) {
    throw "$($familyName.ToUpperInvariant()) family does not list its entry point"
  }
  foreach ($relativePath in $family.files) {
    if (-not $relativePath.StartsWith("llama/$familyName/")) {
      throw "$($familyName.ToUpperInvariant()) family file is outside its isolated directory: $relativePath"
    }
    if (-not $inventory.ContainsKey($relativePath)) {
      throw "$($familyName.ToUpperInvariant()) family file is missing from the hashed inventory: $relativePath"
    }
  }
}

function Invoke-DeviceProbe([string]$BinaryPath) {
  $probeInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $probeInfo.FileName = $BinaryPath
  $probeInfo.WorkingDirectory = Split-Path $BinaryPath -Parent
  $probeInfo.Arguments = "--list-devices"
  $probeInfo.UseShellExecute = $false
  $probeInfo.CreateNoWindow = $true
  $probeInfo.RedirectStandardOutput = $true
  $probeInfo.RedirectStandardError = $true
  $probe = [System.Diagnostics.Process]::new()
  $probe.StartInfo = $probeInfo
  if (-not $probe.Start()) { throw "Runtime device probe did not start: $BinaryPath" }
  try {
    $standardOutput = $probe.StandardOutput.ReadToEndAsync()
    $standardError = $probe.StandardError.ReadToEndAsync()
    if (-not $probe.WaitForExit(10000)) { throw "Runtime device probe timed out: $BinaryPath" }
    $standardOutput.Wait()
    $standardError.Wait()
    return [ordered]@{
      ExitCode = $probe.ExitCode
      Output = "$($standardOutput.Result)`n$($standardError.Result)"
    }
  } finally {
    if (-not $probe.HasExited) { $probe.Kill() }
    $probe.Dispose()
  }
}

$cpuProbe = Invoke-DeviceProbe (Join-Path $root "llama/cpu/llama-server.exe")
if ($cpuProbe.ExitCode -ne 0) { throw "CPU runtime device probe failed with $($cpuProbe.ExitCode)" }
if ($cpuProbe.Output -match '(?im)^\s*CUDA\d+\s*:') {
  throw "CPU runtime unexpectedly exposes a CUDA device"
}

if (-not $CpuOnly) {
  $cudaProbe = Invoke-DeviceProbe (Join-Path $root "llama/cuda/llama-server.exe")
  $hasNvidiaDevice = $cudaProbe.Output -match '(?im)^\s*CUDA\d+\s*:\s*.*\bNVIDIA\b'
  $stableUnavailable = $cudaProbe.ExitCode -eq 0 -and $cudaProbe.Output -notmatch '(?im)^\s*CUDA\d+\s*:'
  if (-not $hasNvidiaDevice -and -not $stableUnavailable) {
    throw "CUDA runtime returned neither an NVIDIA device nor a stable no-device outcome"
  }
}

$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = Join-Path $root "twinscript-local-inference.exe"
$info.WorkingDirectory = $root
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $info
if (-not $process.Start()) { throw "Local host did not start" }
try {
  foreach ($request in @(
    '{"protocolVersion":1,"type":"hello","requestId":"verify-hello","sessionId":"verify"}',
    '{"protocolVersion":1,"type":"health","requestId":"verify-health","sessionId":"verify"}',
    '{"protocolVersion":1,"type":"shutdown","requestId":"verify-stop","sessionId":"verify"}'
  )) {
    $process.StandardInput.WriteLine($request)
    $process.StandardInput.Flush()
    # Windows ships Windows PowerShell 5.1, whose .NET Framework Task does not
    # expose WaitAsync. Keep the timeout without requiring PowerShell 7.
    $readTask = $process.StandardOutput.ReadLineAsync()
    if (-not $readTask.Wait([TimeSpan]::FromSeconds(10))) {
      throw "Timed out waiting for local host reply"
    }
    $reply = $readTask.Result | ConvertFrom-Json
    if ($reply.protocolVersion -ne 1 -or $reply.type -eq "error") {
      throw "Invalid host reply: $($reply | ConvertTo-Json -Compress)"
    }
  }
  if (-not $process.WaitForExit(5000)) { throw "Local host did not exit after shutdown" }
  if ($process.ExitCode -ne 0) { throw "Local host exited with $($process.ExitCode)" }
} finally {
  if (-not $process.HasExited) { $process.Kill() }
  $process.Dispose()
}
Write-Host "Verified local inference host and $($manifest.files.Count) runtime files"
