# Test the real data-directory ACL without changing ProgramData or registration.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'register-dshow-camera.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'DirectShow script does not parse' }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Set-RuntimePublisherAccess' }, $true)
Invoke-Expression $function.Extent.Text
$root = Join-Path ([IO.Path]::GetTempPath()) ('twinscript-acl-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $runtime = Join-Path $root 'runtime'
  New-Item -ItemType Directory -Path $runtime | Out-Null
  [IO.File]::WriteAllText((Join-Path $runtime 'camera-frame-v1.bin'), 'fixture')
  $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # ACL application needs a real principal on this machine, not a made-up SAM SID.
  foreach ($sid in @($operatorSid)) {
    Set-RuntimePublisherAccess $runtime $sid
    $rules = (Get-Acl -LiteralPath $runtime).Access | Where-Object {
      $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid -and
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Modify) -eq [Security.AccessControl.FileSystemRights]::Modify
    }
    if (-not $rules) { throw 'Requesting user did not receive Modify on runtime data' }
  }
  # Entra ID uses authority 12; validate its SID form without inventing a local account.
  [void][Security.Principal.SecurityIdentifier]::new('S-1-12-1-1-2-3-4')
  foreach ($sid in @('Everyone', 'S-1-5-21-1 /grant Everyone:F', 'S-1-5-21-1" & calc.exe')) {
    $failed = $false
    try { Set-RuntimePublisherAccess $runtime $sid } catch { $failed = $true }
    if (-not $failed) { throw 'Invalid requesting SID accepted' }
  }
  $link = Join-Path $root 'redirected-runtime'
  New-Item -ItemType Junction -Path $link -Target $runtime | Out-Null
  $failed = $false
  try { Set-RuntimePublisherAccess $link $operatorSid } catch { $failed = $true }
  if (-not $failed) { throw 'Redirected runtime was accepted' }
  Remove-Item -LiteralPath $link -Force
  $container = Join-Path $root 'container'
  New-Item -ItemType Directory -Path (Join-Path $container 'runtime') -Force | Out-Null
  New-Item -ItemType Junction -Path $link -Target $container | Out-Null
  $failed = $false
  try { Set-RuntimePublisherAccess (Join-Path $link 'runtime') $operatorSid } catch { $failed = $true }
  if (-not $failed) { throw 'Redirected runtime ancestor was accepted' }
  Remove-Item -LiteralPath $link -Force
  Write-Output 'PASS requesting-user runtime Modify ACL, Entra ID SID parsing, invalid SID and redirected-directory refusal'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
