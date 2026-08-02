# Native Camera Diagnostics and macOS Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Windows camera's generic exit-code failure with safe stage diagnostics and repair, while proving all non-driver meeting UX remains available on macOS.

**Architecture:** The elevated PowerShell workflow writes one versioned, sanitized JSON result to a caller-owned diagnostic directory and a detailed protected log to ProgramData. Electron captures the result and exposes recovery actions without affecting the session. Windows-only implementation stays behind platform factories; macOS keeps preview and OBS guidance without loading camera binaries.

**Tech Stack:** PowerShell 5.1, Electron/Node child processes and IPC, React/TypeScript, Node test runner, Squirrel.Windows, Electron Forge macOS packaging.

---

## File map

- Create `electron/captions/native-camera-result.js`: schema and safe messages.
- Create `electron/captions/native-camera-result.test.cjs`: parser/redaction tests.
- Modify `scripts/install-native-camera.ps1`: staged install, JSON result, detailed log.
- Modify `scripts/uninstall-native-camera.ps1`: same result contract.
- Modify `electron/captions/native-camera-installer.js`: capture and parse results.
- Modify `electron/captions/native-camera-installer.test.cjs`: cancel/failure/stage tests.
- Modify `electron/captions/register-caption-ipc.js`: safe diagnostic reveal action.
- Modify `electron/captions-preload.js`, `src/electron.d.ts`, and `src/captions/types.ts`: result types.
- Modify `src/captions/ControlApp.tsx`, `ControlApp.test.tsx`, and `captions.css`: precise failure and recovery controls.
- Modify `forge.config.js` and platform tests: strict Windows-only staging.
- Modify `docs/windows/validation-matrix.md` and evidence README: operator evidence.

### Task 1: Define the native-camera operation result contract

**Files:**
- Create: `electron/captions/native-camera-result.js`
- Create: `electron/captions/native-camera-result.test.cjs`

- [ ] **Step 1: Write failing parser tests**

```js
test('parses a known stage result and strips unsafe paths', () => {
  const result = parseNativeCameraResult(JSON.stringify({
    version: 1,
    ok: false,
    operation: 'install',
    stage: 'prepare-acl',
    code: 'icacls_failed',
    nativeCode: 5,
    detail: 'C:\\Users\\jqian\\secret failed',
  }));
  assert.equal(result.stage, 'prepare-acl');
  assert.equal(result.detail.includes('jqian'), false);
});
```

Also reject unknown versions/stages, more than 16 KiB, embedded API keys, and
nonfinite native codes.

- [ ] **Step 2: Verify module-not-found failure**

Run `node --test electron/captions/native-camera-result.test.cjs`.

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement allow-listed parsing**

```js
const STAGES = new Set([
  'preflight', 'stage-files', 'prepare-acl', 'remove-legacy-registration',
  'register-source', 'verify-registration', 'verify-companion', 'complete',
]);

function safeDetail(value) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '%USERPROFILE%')
    .slice(0, 600);
}
```

Return only `version`, `ok`, `operation`, `stage`, `code`, `nativeCode`,
`detail`, and `diagnosticAvailable`.

- [ ] **Step 4: Run parser tests**

Run the focused Node test; expected PASS.

### Task 2: Make the elevated installer stage-reporting and recoverable

**Files:**
- Modify: `scripts/install-native-camera.ps1`
- Modify: `scripts/uninstall-native-camera.ps1`
- Test: `electron/captions/native-camera-installer.test.cjs`

- [ ] **Step 1: Add failing command-contract tests**

Assert the spawned PowerShell command includes a main-process-generated
`-ResultPath`, and that exit 1 with a valid result becomes an error whose
`stage` is preserved.

- [ ] **Step 2: Verify current tests fail**

Run `node --test electron/captions/native-camera-installer.test.cjs`.

Expected: FAIL because stdout is ignored and no result path exists.

- [ ] **Step 3: Add parameters and atomic result writing**

Add mandatory `ResultPath` to the outer invocation and forward it to the
elevated invocation. Use:

```powershell
function Write-OperationResult {
  param([bool]$Ok, [string]$Stage, [string]$Code, [Nullable[int]]$NativeCode, [string]$Detail)
  $payload = [ordered]@{
    version = 1; ok = $Ok; operation = 'install'; stage = $Stage
    code = $Code; nativeCode = $NativeCode; detail = $Detail
    diagnosticAvailable = (Test-Path -LiteralPath $script:LogPath)
  } | ConvertTo-Json -Compress
  $temporary = "$ResultPath.tmp"
  [IO.File]::WriteAllText($temporary, $payload, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $ResultPath -Force
}
```

Validate the resolved result path against the exact diagnostic directory
created by the main process before writing.

- [ ] **Step 4: Wrap each install stage**

```powershell
function Invoke-InstallStage {
  param([string]$Name, [scriptblock]$Action)
  $script:CurrentStage = $Name
  & $Action
}
```

Run preflight, stage-files, prepare-acl, remove-legacy-registration,
register-source, verify-registration, and verify-companion through the wrapper.
The top-level catch writes a failure result using `CurrentStage`, appends the
full exception to the protected ProgramData log, and exits 1. Success writes
stage `complete` and exits 0.

- [ ] **Step 5: Stage and hash binaries before registry mutation**

Copy both source files into a PID-specific directory under the protected
install root. Compute SHA-256 for source and staged copies and compare. Only
then remove the exact product CLSID and replace installed binaries. On any
copy/hash failure, leave the existing registration untouched.

- [ ] **Step 6: Apply the same result contract to removal**

Use operation `remove`, with stages preflight, unregister-source, remove-files,
and complete. Removal remains idempotent if the product CLSID or files are
already absent.

- [ ] **Step 7: Run script-contract tests**

Run `npm run test:captions`.

Expected: PASS without requiring elevation because tests use process doubles.

### Task 3: Capture structured results in Electron

**Files:**
- Modify: `electron/captions/native-camera-installer.js:11-136`
- Test: `electron/captions/native-camera-installer.test.cjs`

- [ ] **Step 1: Write failing success/failure/cancel tests**

Cover exit 0 with `complete`, exit 1 with `prepare-acl`, missing result file,
malformed JSON, and UAC cancellation 1223. Assert no full user path reaches the
error message.

- [ ] **Step 2: Add diagnostic directory injection**

Constructor inputs gain `diagnosticDirectory`, `readFileSync`, `mkdirSync`, and
`randomUUID`. Resolve each result file beneath that exact directory and pass it
to PowerShell.

- [ ] **Step 3: Capture child output with limits**

Spawn with:

```js
{ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
```

Collect at most 16 KiB per stream for fallback diagnostics. On close, prefer a
valid result file. If absent, return code `native_camera_result_missing` with
the exit code and sanitized bounded stderr.

- [ ] **Step 4: Attach structured data to operation errors**

```js
error.stage = result.stage;
error.nativeCode = result.nativeCode;
error.detail = result.detail;
error.diagnosticAvailable = result.diagnosticAvailable;
```

Keep the established approval-canceled code for exit 1223.

- [ ] **Step 5: Run installer tests**

Run `node --test electron/captions/native-camera-installer.test.cjs electron/captions/native-camera-result.test.cjs`.

Expected: PASS.

### Task 4: Expose precise recovery UX and diagnostic reveal

**Files:**
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-preload.js`
- Modify: `src/electron.d.ts`
- Modify: `src/captions/types.ts`
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/ControlApp.test.tsx`
- Modify: `src/captions/captions.css`

- [ ] **Step 1: Write a failing UI test for an ACL-stage failure**

```tsx
it('shows the failed camera stage and recovery controls', async () => {
  window.captions.installNativeCamera = vi.fn(() => Promise.resolve({
    ok: false as const,
    error: {
      code: 'native_camera_install_failed', stage: 'prepare-acl',
      message: 'Could not prepare the camera folder.', diagnosticAvailable: true,
    },
  }));
  render(<ControlApp />);
  fireEvent.click(await screen.findByRole('button', { name: 'Virtual camera' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Install native camera' }));
  expect(await screen.findByText(/prepare camera folder/i)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Retry installation' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Open diagnostics' })).toBeVisible();
});
```

- [ ] **Step 2: Verify the focused test fails**

Run `npx vitest run src/captions/ControlApp.test.tsx`.

Expected: FAIL because the app only exposes a generic banner.

- [ ] **Step 3: Serialize safe operation errors through IPC**

Return allow-listed fields from Task 3. Add
`captions:reveal-native-camera-diagnostics`, sender validation, and main-process
`shell.showItemInFolder`/`shell.openPath` for the fixed diagnostic directory.
Renderer input cannot supply a path.

- [ ] **Step 4: Add stage-specific messages**

Map known stages to plain language. For example:

```ts
const CAMERA_STAGE_MESSAGES = {
  'prepare-acl': 'Windows could not prepare the protected camera folder.',
  'register-source': 'Windows could not register the camera source.',
  'verify-registration': 'The camera registered but failed verification.',
} as const;
```

Render Retry installation, Open diagnostics when available, and OBS fallback.
Do not disable session controls or transcription.

- [ ] **Step 5: Run renderer and IPC tests**

Run `npx vitest run src/captions/ControlApp.test.tsx` and
`npm run test:captions`.

Expected: PASS.

### Task 5: Enforce macOS parity and strict driver exclusion

**Files:**
- Modify: `forge.config.js`
- Modify: `electron/captions/native-camera-supervisor.test.cjs`
- Modify: `electron/captions/native-camera-ipc.test.cjs`
- Modify: `src/captions/ControlApp.test.tsx`

- [ ] **Step 1: Add failing non-Windows packaging and UI assertions**

Assert `stageNativeCameraResources(buildPath, 'darwin')` performs no file
operations, native camera IPC reports `windows-only`, and the macOS renderer
shows camera-stage preview plus OBS guidance but no Install/Repair/Remove camera
buttons.

- [ ] **Step 2: Run focused tests**

Run Node camera tests and `npx vitest run src/captions/ControlApp.test.tsx`.

Expected: tests identify any current parity or platform-gating gaps.

- [ ] **Step 3: Keep the output selector cross-platform**

On macOS, label the second route Camera stage/OBS rather than removing it. The
same Preview/Hide preview, shared layout, history, theme, and full-screen stage
remain available. Only the native driver card and install action are absent.

- [ ] **Step 4: Keep Windows resources out of macOS packages**

Ensure PowerShell scripts, `vcam-host.exe`, and
`twinscript-vcam-source.dll` are staged only from the `win32` branch. The macOS
package includes the local Translation helper agent from the translation plan,
not camera components.

- [ ] **Step 5: Run automated platform gates**

```powershell
npm run test:captions
npx vitest run
npm run build
```

Expected: PASS.

### Task 6: Validate real install/repair and macOS workflow

**Files:**
- Modify: `docs/windows/validation-matrix.md`
- Modify: `docs/windows/evidence/2026-08-01-w4-production/README.md`

- [ ] **Step 1: Reproduce installation with the new diagnostic path**

On Windows, run Install native camera and approve UAC. If it fails, capture the
stage, safe message, native code, and diagnostic file; do not copy sensitive
paths into evidence.

- [ ] **Step 2: Verify registry migration and camera consumption**

Confirm the product CLSID points to the protected ProgramData DLL, the legacy
`C:\Users\Public\twinscript-vcam3` registration is gone, status-machine passes,
and a separate consumer receives the camera feed.

- [ ] **Step 3: Verify idempotent lifecycle**

Run install, repair, repair again, remove, and install. Expected: every action
reports its exact completed stage and leaves no broken intermediate state.

- [ ] **Step 4: Run macOS major-UX parity**

On macOS, start/stop a session, test microphone and system audio, local/cloud
translation, overlays, both stage layouts, Preview/Hide/Escape, themes,
glossary, recording, reveal folder, Keep/Discard, and OBS capture. Expected:
native-camera driver actions are the only absent workflow.

- [ ] **Step 5: Record honest gate status**

Update evidence with automated output and actual hardware observations. W4
remains pending until a meeting client and soak test pass; macOS parity remains
pending until run on real macOS hardware.
