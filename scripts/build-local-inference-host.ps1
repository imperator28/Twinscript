param(
  [string]$OpenVinoRoot,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$LlamaCpuRoot,
  [string]$LlamaCudaRoot,
  [string]$LlamaRevision = "b9940",
  [switch]$CpuOnly,
  [switch]$ReuseStagedHost,
  [string]$BuildDirectory = "native/local-inference-host/build-release",
  [ValidateSet("Release")][string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repository = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$source = Join-Path $repository "native/local-inference-host"
$build = [System.IO.Path]::GetFullPath((Join-Path $repository $BuildDirectory))
$output = [System.IO.Path]::GetFullPath((Join-Path $repository $OutputDirectory))
function Get-CompatibleRelativePath([string]$BasePath, [string]$TargetPath) {
  $baseFullPath = [System.IO.Path]::GetFullPath($BasePath).TrimEnd("\") + "\"
  $targetFullPath = [System.IO.Path]::GetFullPath($TargetPath)
  $baseUri = [System.Uri]::new($baseFullPath)
  $targetUri = [System.Uri]::new($targetFullPath)
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace("/", "\")
}
if ([string]::IsNullOrWhiteSpace($LlamaRevision)) { throw "LlamaRevision is required" }
if (-not $CpuOnly -and [string]::IsNullOrWhiteSpace($LlamaCudaRoot)) {
  throw "LlamaCudaRoot is required unless -CpuOnly is explicitly selected"
}
if ($ReuseStagedHost) {
  foreach ($requiredFile in @("twinscript-local-inference.exe", "openvino.dll", "openvino_genai.dll")) {
    if (-not (Test-Path -LiteralPath (Join-Path $output $requiredFile) -PathType Leaf)) {
      throw "ReuseStagedHost requires an existing staged file: $requiredFile"
    }
  }
} else {
  if ([string]::IsNullOrWhiteSpace($OpenVinoRoot)) { throw "OpenVinoRoot is required for a native build" }
  $sdk = (Resolve-Path $OpenVinoRoot).Path
  $runtime = if (Test-Path (Join-Path $sdk "runtime/cmake/OpenVINOGenAIConfig.cmake")) {
    Join-Path $sdk "runtime"
  } elseif (Test-Path (Join-Path $sdk "cmake/OpenVINOGenAIConfig.cmake")) {
    $sdk
  } else {
    throw "OpenVINO GenAI CMake package was not found under $sdk"
  }
  $cmakePackage = Join-Path $runtime "cmake"

  cmake -S $source -B $build -A x64 `
    -DTWINSCRIPT_OPENVINO_GENAI=ON `
    "-DOpenVINOGenAI_DIR=$cmakePackage" `
    "-DOpenVINO_DIR=$cmakePackage"
  if ($LASTEXITCODE -ne 0) { throw "CMake configure failed" }
  cmake --build $build --config $Configuration
  if ($LASTEXITCODE -ne 0) { throw "Native host build failed" }

  $previousPath = $env:PATH
  try {
    $env:PATH = "$(Join-Path $runtime 'bin/intel64/Release');$(Join-Path $runtime '3rdparty/tbb/bin');$env:PATH"
    ctest --test-dir $build -C $Configuration --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw "Native host tests failed" }
  } finally {
    $env:PATH = $previousPath
  }

  New-Item -ItemType Directory -Path $output -Force | Out-Null
  Copy-Item (Join-Path $build "$Configuration/twinscript-local-inference.exe") $output -Force

  $runtimeFiles = @(
    "openvino.dll",
    "openvino_genai.dll",
    "openvino_ir_frontend.dll",
    "openvino_tokenizers.dll",
    "openvino_intel_npu_plugin.dll",
    "openvino_intel_npu_compiler_loader.dll",
    "openvino_intel_npu_compiler.dll",
    "openvino_intel_npu_vm_runtime.dll",
    "openvino_intel_cpu_plugin.dll"
  )
  foreach ($name in $runtimeFiles) {
    Copy-Item (Join-Path $runtime "bin/intel64/Release/$name") $output -Force
  }
  Copy-Item (Join-Path $runtime "3rdparty/tbb/bin/tbb12.dll") $output -Force

  $notices = Join-Path $output "notices/openvino"
  New-Item -ItemType Directory -Path $notices -Force | Out-Null
  $licenseRoot = Join-Path (Split-Path $runtime -Parent) "docs/licensing"
  foreach ($name in @("LICENSE", "LICENSE-GENAI", "runtime-third-party-programs.txt", "third-party-programs-genai.txt")) {
    Copy-Item (Join-Path $licenseRoot $name) $notices -Force
  }
}

function Copy-LlamaFamily([string]$Name, [string]$SourceRoot) {
  $sourceRoot = (Resolve-Path $SourceRoot).Path
  $familyOutput = [System.IO.Path]::GetFullPath((Join-Path $output "llama/$Name"))
  $relativeTarget = Get-CompatibleRelativePath $output $familyOutput
  if ($relativeTarget.StartsWith("..") -or [System.IO.Path]::IsPathRooted($relativeTarget)) {
    throw "Refusing to replace runtime family outside the output directory: $familyOutput"
  }
  if (-not $sourceRoot.Equals($familyOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $familyOutput) {
      Remove-Item -LiteralPath $familyOutput -Recurse -Force
    }
    New-Item -ItemType Directory -Path $familyOutput -Force | Out-Null
    Copy-Item (Join-Path $sourceRoot "*") $familyOutput -Recurse -Force
  }
  $entryPoint = Join-Path $familyOutput "llama-server.exe"
  if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "The $Name runtime is missing llama-server.exe"
  }

  return @(
    Get-ChildItem $familyOutput -Recurse -File |
      Sort-Object FullName |
      ForEach-Object {
        (Get-CompatibleRelativePath $output $_.FullName).Replace("\", "/")
      }
  )
}

$cpuFamilyFiles = @(Copy-LlamaFamily "cpu" $LlamaCpuRoot)
$cudaFamilyFiles = @()
if (-not $CpuOnly) {
  $cudaFamilyFiles = @(Copy-LlamaFamily "cuda" $LlamaCudaRoot)
}

$files = Get-ChildItem $output -Recurse -File |
  Where-Object { $_.Name -ne "runtime-manifest.json" } |
  Sort-Object FullName |
  ForEach-Object {
    [ordered]@{
      path = (Get-CompatibleRelativePath $output $_.FullName).Replace("\", "/")
      size = $_.Length
      sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
$manifest = [ordered]@{
  schemaVersion = 2
  artifactKind = if ($CpuOnly) { "cpu-only-development" } else { "release" }
  runtime = "openvino-genai-2026.3+llama.cpp-$LlamaRevision"
  runtimeFamilies = [ordered]@{
    cpu = [ordered]@{
      revision = $LlamaRevision
      entryPoint = "llama/cpu/llama-server.exe"
      files = @($cpuFamilyFiles)
    }
  }
  files = @($files)
}
if (-not $CpuOnly) {
  $manifest.runtimeFamilies["cuda"] = [ordered]@{
    revision = $LlamaRevision
    entryPoint = "llama/cuda/llama-server.exe"
    files = @($cudaFamilyFiles)
  }
}
$manifestJson = $manifest | ConvertTo-Json -Depth 5
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $output "runtime-manifest.json"), $manifestJson, $utf8WithoutBom)
Write-Host "Staged local inference host at $output"
