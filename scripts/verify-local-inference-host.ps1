param(
  [Parameter(Mandatory = $true)][string]$HostDirectory
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path $HostDirectory).Path
$manifestPath = Join-Path $root "runtime-manifest.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) { throw "Unsupported runtime manifest" }
foreach ($entry in $manifest.files) {
  if ($entry.path -match "(^|/)(python|python3)(\.exe)?$") {
    throw "Python runtime is not permitted in the native host artifact"
  }
  $file = Join-Path $root $entry.path
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing runtime file: $($entry.path)" }
  if ((Get-Item -LiteralPath $file).Length -ne $entry.size) { throw "Size mismatch: $($entry.path)" }
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $entry.sha256) { throw "Hash mismatch: $($entry.path)" }
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
