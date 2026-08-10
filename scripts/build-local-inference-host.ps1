param(
  [Parameter(Mandatory = $true)][string]$OpenVinoRoot,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$LlamaRoot,
  [string]$BuildDirectory = "native/local-inference-host/build-release",
  [ValidateSet("Release")][string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$repository = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$source = Join-Path $repository "native/local-inference-host"
$build = [System.IO.Path]::GetFullPath((Join-Path $repository $BuildDirectory))
$output = [System.IO.Path]::GetFullPath((Join-Path $repository $OutputDirectory))
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

if ($LlamaRoot) {
  $llamaSource = (Resolve-Path $LlamaRoot).Path
  $llamaOutput = Join-Path $output "llama"
  New-Item -ItemType Directory -Path $llamaOutput -Force | Out-Null
  Copy-Item (Join-Path $llamaSource "*.exe") $llamaOutput -Force
  Copy-Item (Join-Path $llamaSource "*.dll") $llamaOutput -Force
}

$files = Get-ChildItem $output -Recurse -File |
  Where-Object { $_.Name -ne "runtime-manifest.json" } |
  Sort-Object FullName |
  ForEach-Object {
    [ordered]@{
      path = [System.IO.Path]::GetRelativePath($output, $_.FullName).Replace("\", "/")
      size = $_.Length
      sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
$manifest = [ordered]@{
  schemaVersion = 1
  runtime = "openvino-genai-2026.3+llama.cpp-b9940"
  files = @($files)
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $output "runtime-manifest.json") -Encoding utf8
Write-Host "Staged local inference host at $output"
