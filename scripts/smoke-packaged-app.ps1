<#
.SYNOPSIS
Launch/exit smoke test for the packaged Windows app.

.DESCRIPTION
Answers three questions a build artifact cannot answer on its own:

  1. Does the packaged app start at all? A missing native module or a bad asar
     path fails here and nowhere else in CI.
  2. Does it survive startup? An app that crashes two seconds in still "starts".
  3. Does closing its window actually end it?

Question 3 is the reason this exists. The caption overlay windows intercept
`close` and hide themselves so the operator can dismiss captions mid-session,
which means Electron's `window-all-closed` never fires. Before
electron/captions/app-lifecycle.js, closing the control window left the app
running with no taskbar entry, holding microphone and loopback capture open —
seven orphaned processes. CloseMainWindow() sends WM_CLOSE, exactly what the
window's X button does, so this is a real regression guard rather than a
process-management exercise.

Stop-Process is deliberately NOT used to end the app: killing the tree would
pass whether or not the lifecycle wiring works.

.PARAMETER PackageDir
Directory holding the packaged app. Defaults to the forge output path.

.PARAMETER StartupSeconds
How long the app must stay alive to count as having survived startup.

.PARAMETER ShutdownSeconds
How long every process gets to exit after the window close.

.PARAMETER ControlWindowTitle
Title of the control window. The check waits for MainWindowHandle to point at
THIS window before closing it, which matters: for roughly the first second of
startup MainWindowHandle resolves to 'Twinscript Camera Stage' instead. Closing
that window makes it hide itself and leaves the app running - correct app
behaviour that reads as a lifecycle failure if the test closes the wrong window.
#>
[CmdletBinding()]
param(
  [string]$PackageDir = 'out/Twinscript-win32-x64',
  [int]$StartupSeconds = 20,
  [int]$ShutdownSeconds = 40,
  [string]$ControlWindowTitle = 'Twinscript'
)

$ErrorActionPreference = 'Stop'

# Set once this run has actually started the app. Any failure after that point
# must sweep the tree, or a CI runner is left holding orphaned processes that
# make every subsequent run abort on "already running".
$script:launched = $false

function Fail([string]$message) {
  if ($script:launched) {
    if (-not (Stop-AppProcesses)) {
      Write-Output '  WARNING: could not terminate every process from this image'
    }
  }
  Write-Output "FAIL  $message"
  exit 1
}

# Killing a tree of Electron processes races their own spawning: a single
# Stop-Process pass can miss a child created between enumeration and kill,
# which then makes the NEXT run abort on "already running". Sweep until clear.
function Stop-AppProcesses {
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    $alive = @(Get-AppProcesses)
    if ($alive.Count -eq 0) { return $true }
    $alive | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
  }
  return (@(Get-AppProcesses).Count -eq 0)
}

$exePath = Join-Path $PackageDir 'twinscript.exe'
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
  Fail "packaged executable not found: $exePath"
}
$exeFullPath = (Resolve-Path -LiteralPath $exePath).Path
$processName = [System.IO.Path]::GetFileNameWithoutExtension($exeFullPath)

# Only ever consider processes started from this exact image. A developer's own
# installed copy must not make the check pass or fail.
function Get-AppProcesses {
  Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -eq $exeFullPath } catch { $false }
  }
}

$preexisting = @(Get-AppProcesses)
if ($preexisting.Count -gt 0) {
  Fail "$($preexisting.Count) process(es) already running from $exeFullPath; cannot attribute the result"
}

Write-Output "launching $exeFullPath"
$proc = Start-Process -FilePath $exeFullPath -PassThru
$script:launched = $true

# --- 1. does it start, and does it stay up ------------------------------------

$deadline = (Get-Date).AddSeconds($StartupSeconds)
$windowHandle = [IntPtr]::Zero
$seenTitles = New-Object System.Collections.Generic.HashSet[string]
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) {
    Fail "the app exited during startup with code $($proc.ExitCode)"
  }
  $proc.Refresh()
  $title = $proc.MainWindowTitle
  if ($title) { [void]$seenTitles.Add($title) }
  # Wait for the CONTROL window specifically, not merely any window. Accepting
  # the first non-zero handle closes 'Twinscript Camera Stage' instead, which
  # hides itself by design and makes a healthy app look like a leak.
  if ($proc.MainWindowHandle -ne [IntPtr]::Zero -and $title -eq $ControlWindowTitle) {
    $windowHandle = $proc.MainWindowHandle
    break
  }
  Start-Sleep -Milliseconds 250
}

if ($windowHandle -eq [IntPtr]::Zero) {
  if ($seenTitles.Count -gt 0) {
    Write-Output "  windows seen during startup: $($seenTitles -join ', ')"
    Write-Output "  but never '$ControlWindowTitle'"
  }
  # No window inside the budget. Distinguish "crashed" from "headless runner",
  # because those need completely different follow-up.
  if ($proc.HasExited) {
    Fail "the app exited during startup with code $($proc.ExitCode)"
  }
  $children = @(Get-AppProcesses)
  Write-Output "  no control window within ${StartupSeconds}s; $($children.Count) process(es) alive"
  Fail 'the control window never appeared. On a runner without an interactive desktop session this is an environment limitation, not necessarily an app defect - check whether the runner has a desktop.'
}

Write-Output "  control window '$ControlWindowTitle' ready (pid $($proc.Id))"

# Electron spawns helper processes (GPU, renderer, utility). Record them: they
# are what leaked before the lifecycle fix.
$running = @(Get-AppProcesses)
Write-Output "  $($running.Count) process(es) from this image after startup"

# Survive-startup window. An app that dies here launched but did not run.
Start-Sleep -Seconds 3
if ($proc.HasExited) {
  Fail "the app exited $($proc.ExitCode) shortly after showing its window"
}
Write-Output '  still running after startup settle'

# --- 2. does closing the window end the whole app -----------------------------

# Re-read the handle immediately before closing: it moves during startup, and a
# stale handle sends WM_CLOSE to a window that is no longer the control window.
$proc.Refresh()
if ($proc.MainWindowTitle -ne $ControlWindowTitle) {
  Fail "the main window changed from '$ControlWindowTitle' to '$($proc.MainWindowTitle)' before it could be closed"
}
Write-Output "  sending WM_CLOSE to '$($proc.MainWindowTitle)'"
$closeAccepted = $proc.CloseMainWindow()
if (-not $closeAccepted) {
  Write-Output '  CloseMainWindow() returned false (window may already be closing)'
}

# Time the shutdown. A correct-but-slow exit (a cold machine with antivirus
# scanning 140 MB of freshly written binaries) and a genuine hang look identical
# if all that is reported is "still alive after N seconds".
$closeStarted = Get-Date
$shutdownDeadline = $closeStarted.AddSeconds($ShutdownSeconds)
while ((Get-Date) -lt $shutdownDeadline) {
  if (@(Get-AppProcesses).Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
$shutdownSeconds = [math]::Round(((Get-Date) - $closeStarted).TotalSeconds, 1)

$survivors = @(Get-AppProcesses)
if ($survivors.Count -gt 0) {
  Write-Output ''
  Write-Output "  $($survivors.Count) process(es) still alive ${ShutdownSeconds}s after the window closed:"
  foreach ($survivor in $survivors) {
    Write-Output "    pid $($survivor.Id)  $($survivor.ProcessName)"
  }
  Fail 'closing the control window did not end the app. This is the app-lifecycle regression: see electron/captions/app-lifecycle.js.'
}

Write-Output ''
Write-Output "PASS  launched, survived startup, and exited completely ${shutdownSeconds}s after window close"
exit 0
