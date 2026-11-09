# Behavioral tests with an in-memory registry and real temporary files. Never
# touches machine registration and never requires administrator approval.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'uninstall-native-camera.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Uninstall script does not parse' }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-TwinscriptCameraInstallation' }, $true)
Invoke-Expression $function.Extent.Text
$classes = 'Registry::HKEY_LOCAL_MACHINE\Software\Classes\CLSID'
$filter = '{1F5A7C2E-8D64-4B93-9E11-3A6C5D8F27B4}'
$category = "$classes\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance"
$legacy = "$classes\{6B8F2C4A-9D3E-4A17-8C25-1E7B4F6D9A03}"
$script:registry = @{}
$script:removed = @()
$script:failKey = ''
function Test-Path {
  param([string]$LiteralPath)
  if ($LiteralPath.StartsWith('Registry::')) { return $script:registry.ContainsKey($LiteralPath) }
  Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
}
function Get-ChildItem {
  param([string]$LiteralPath, [switch]$Recurse, [switch]$File)
  if ($LiteralPath.StartsWith('Registry::')) {
    foreach ($key in @($script:registry.Keys)) {
      if ($key.StartsWith($LiteralPath + '\')) { [pscustomobject]@{ PSPath = $key; PSChildName = $key.Substring($LiteralPath.Length + 1) } }
    }
    return
  }
  Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -Recurse:$Recurse -File:$File
}
function Get-ItemProperty { param([string]$LiteralPath) return $script:registry[$LiteralPath] }
function Remove-Item {
  param([string]$LiteralPath, [switch]$Recurse, [switch]$Force)
  if ($LiteralPath.StartsWith('Registry::')) {
    if ($LiteralPath -eq $script:failKey) { throw 'Injected registry access denied' }
    $script:removed += $LiteralPath
    [void]$script:registry.Remove($LiteralPath)
    return
  }
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force
}
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Reset-Registry {
  $script:registry = @{
    $category = [pscustomobject]@{}
    "$classes\$filter" = [pscustomobject]@{}
    $legacy = [pscustomobject]@{}
    "$category\$filter" = [pscustomobject]@{ CLSID = $filter }
    "$category\Twinscript" = [pscustomobject]@{ CLSID = $filter }
    "$category\OtherCamera" = [pscustomobject]@{ CLSID = '{OTHER}' }
  }
  $script:removed = @()
  $script:failKey = ''
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('twinscript-removal-test-' + [guid]::NewGuid())
try {
  Reset-Registry
  Remove-TwinscriptCameraInstallation $root
  Assert ($script:registry.ContainsKey("$category\OtherCamera")) 'Other camera was removed'
  Assert (-not $script:registry.ContainsKey("$classes\$filter")) 'Missing-DLL COM entry survived'
  Assert (-not $script:registry.ContainsKey("$category\Twinscript")) 'Legacy category entry survived'
  Assert ($script:removed[0].StartsWith($category)) 'COM entry removed before camera category'
  Remove-TwinscriptCameraInstallation $root
  Write-Output 'PASS missing DLL, legacy/category cleanup, unrelated camera, idempotence'

  Reset-Registry
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  foreach ($name in @('twinscript-dshow-camera.dll', 'twinscript-dshow-camera-20261109-123456.dll')) {
    [IO.File]::WriteAllText((Join-Path $root $name), 'test fixture')
  }
  $script:failKey = "$category\$filter"
  $failed = $false
  try { Remove-TwinscriptCameraInstallation $root } catch { $failed = $true }
  Assert $failed 'Registry failure reported success'
  Assert ((Microsoft.PowerShell.Management\Get-ChildItem $root).Count -eq 2) 'Files deleted on registration failure'
  Write-Output 'PASS registration failure preserves all files'

  Reset-Registry
  $lock = [IO.File]::Open((Join-Path $root 'twinscript-dshow-camera.dll'), 'Open', 'Read', 'None')
  try {
    $failed = $false
    try { Remove-TwinscriptCameraInstallation $root } catch { $failed = $true }
    Assert $failed 'Loaded DLL reported success'
    Assert ((Microsoft.PowerShell.Management\Get-ChildItem $root).Count -eq 2) 'Loaded DLL failure partially deleted files'
  } finally { $lock.Dispose() }
  Remove-TwinscriptCameraInstallation $root
  Assert (-not (Test-Path -LiteralPath $root)) 'Versioned DLL files survived successful retry'
  Write-Output 'PASS loaded DLL preserves files; retry removes versioned copies'
} finally {
  if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $root) {
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $root -Recurse -Force
  }
}
