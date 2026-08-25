# HY-MT2 CUDA Acceleration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically accelerate the selected local HY-MT2 translation model with the packaged NVIDIA CUDA runtime on compatible Windows hardware, while preserving the current CPU runtime as a one-way, fully local fallback and reporting the device actually used.

**Architecture:** Keep the existing caption and translation contracts intact. Parameterize the current persistent llama.cpp server as one runtime-family process, add a bounded CUDA capability probe, and place a session-scoped HY-MT2 runtime controller above the CPU and CUDA server instances. The controller owns automatic selection, generation invalidation, one-way CUDA-to-CPU fallback, and truthful provenance; the existing supervisor and hybrid client continue to expose one translation service. Package the b9940 CPU and CUDA 12.4 families in isolated directories, verified by one release manifest.

**Tech Stack:** Electron 40 main process, Node.js CommonJS and `node:test`, React 19/TypeScript, llama.cpp b9940 Windows x64 CPU and CUDA 12.4 release assets, PowerShell 5.1-compatible release scripts, Electron Forge.

**Spec:** `docs/superpowers/specs/2026-08-25-hy-mt2-cuda-acceleration-design.md`

---

## File and responsibility map

- `electron/captions/llama-runtime-probe.js`: bounded `--list-devices` process, output parser, cache, and invalidation.
- `electron/captions/llama-translation-client.js`: one persistent llama.cpp process configured for either CPU or CUDA; prompt behavior remains unchanged.
- `electron/captions/hy-mt2-runtime-controller.js`: session-scoped automatic selection, process generation, one-way CPU fallback, final-request retry, preview cancellation, and merged health.
- `electron/captions/local-inference-paths.js`: isolated `llama/cpu` and `llama/cuda` executable paths.
- `electron/captions/local-inference-supervisor.js`: constructs the controller and treats either runtime as the same installed HY-MT2 model.
- `electron/captions/local-inference-runtime.js` and `electron/captions-main.js`: inject the development rollout flag without adding a user-facing model choice.
- `electron/captions/translation-backends.js`, `electron/captions/local-model-service.js`, and `src/captions/types.ts`: carry sanitized runtime provenance across the main/renderer boundary.
- `src/captions/ControlApp.tsx` and `src/captions/LocalModelInstallCard.tsx`: present GPU, partial offload, CPU fallback, and CPU status only after runtime evidence exists.
- `scripts/llama-windows-runtime-lock.json`: exact official archive names, URLs, and SHA-256 values.
- `scripts/stage-llama-windows-runtimes.ps1`: verified archive acquisition/extraction into isolated runtime-family folders.
- `scripts/build-local-inference-host.ps1` and `scripts/verify-local-inference-host.ps1`: build/stage manifest and integrity verification for both families.
- `scripts/smoke-local-inference.cjs`, `native/local-inference-host/tests/hymt2_server_smoke.cjs`, and a new `scripts/benchmark-hymt2-runtimes.cjs`: real binary correctness, fallback, and latency gates.
- `forge.config.js`: package the already-verified complete runtime tree; no CUDA toolkit dependency is introduced.

## Fixed implementation decisions

- Pin llama.cpp `b9940` for both runtime families.
- Pin the official Windows x64 assets:
  - `llama-b9940-bin-win-cpu-x64.zip`, SHA-256 `d5d7248c7aacaeb0c8f15311acb0f1081874aa7a5de55843702e9e2394a05788`.
  - `llama-b9940-bin-win-cuda-12.4-x64.zip`, SHA-256 `1eb3afec18662b69a8e6716978e61263c8b9f4829a6e929b8fcdcc142be51893`.
  - `cudart-llama-bin-win-cuda-12.4-x64.zip`, SHA-256 `8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6`.
- Use `TWINSCRIPT_HYMT2_CUDA=1` as the development-only enable flag. The flag changes execution hardware, never the selected translation model or privacy policy.
- Keep `-c 2048`, temperature `0`, and `max_tokens: 256` unchanged.
- CPU uses `--gpu-layers 0`. CUDA uses `--device CUDA0 --gpu-layers auto --fit on`.
- Normalize actual devices to `CUDA0` or `CPU`; `GPU` is renderer copy only, never protocol evidence.
- One controller instance may fall back from CUDA to CPU once per meeting. It never changes back during that meeting.

### Task 1: Pin and stage isolated Windows llama.cpp runtime families

**Files:**
- Create: `scripts/llama-windows-runtime-lock.json`
- Create: `scripts/stage-llama-windows-runtimes.ps1`
- Create: `scripts/stage-llama-windows-runtimes.test.cjs`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing lock/layout tests**

Create `scripts/stage-llama-windows-runtimes.test.cjs` with tests that load the lock file and require the exact revision, archive hashes, and isolated output paths:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'llama-windows-runtime-lock.json'),
  'utf8',
));

test('Windows llama lock pins one b9940 CPU family and one CUDA 12.4 family', () => {
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.revision, 'b9940');
  assert.equal(lock.cpu.archives[0].sha256,
    'd5d7248c7aacaeb0c8f15311acb0f1081874aa7a5de55843702e9e2394a05788');
  assert.deepEqual(lock.cuda.archives.map((entry) => entry.sha256), [
    '1eb3afec18662b69a8e6716978e61263c8b9f4829a6e929b8fcdcc142be51893',
    '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
  ]);
});

test('stager names isolated cpu and cuda destinations', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'stage-llama-windows-runtimes.ps1'),
    'utf8',
  );
  assert.match(source, /Join-Path \$OutputDirectory "cpu"/);
  assert.match(source, /Join-Path \$OutputDirectory "cuda"/);
  assert.doesNotMatch(source, /Copy-Item[^\r\n]+\$OutputDirectory[^\r\n]+-Force/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test scripts/stage-llama-windows-runtimes.test.cjs`

Expected: FAIL because the lock file and stager do not exist.

- [ ] **Step 3: Add the exact runtime lock**

Create `scripts/llama-windows-runtime-lock.json`:

```json
{
  "schemaVersion": 1,
  "revision": "b9940",
  "cpu": {
    "directory": "cpu",
    "archives": [
      {
        "name": "llama-b9940-bin-win-cpu-x64.zip",
        "url": "https://github.com/ggml-org/llama.cpp/releases/download/b9940/llama-b9940-bin-win-cpu-x64.zip",
        "sha256": "d5d7248c7aacaeb0c8f15311acb0f1081874aa7a5de55843702e9e2394a05788"
      }
    ]
  },
  "cuda": {
    "directory": "cuda",
    "archives": [
      {
        "name": "llama-b9940-bin-win-cuda-12.4-x64.zip",
        "url": "https://github.com/ggml-org/llama.cpp/releases/download/b9940/llama-b9940-bin-win-cuda-12.4-x64.zip",
        "sha256": "1eb3afec18662b69a8e6716978e61263c8b9f4829a6e929b8fcdcc142be51893"
      },
      {
        "name": "cudart-llama-bin-win-cuda-12.4-x64.zip",
        "url": "https://github.com/ggml-org/llama.cpp/releases/download/b9940/cudart-llama-bin-win-cuda-12.4-x64.zip",
        "sha256": "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6"
      }
    ]
  }
}
```

- [ ] **Step 4: Implement fail-closed staging**

Create a PowerShell 5.1-compatible script that:

1. Reads the lock.
2. Downloads each archive to a caller-supplied cache only when absent.
3. Verifies SHA-256 before extraction.
4. Extracts CPU only into `llama/cpu/` and both CUDA archives only into `llama/cuda/`.
5. Requires `llama-server.exe` in each destination.
6. Rejects Python executables, nested runtime-family directories, and an empty DLL set.
7. Writes `runtime-family.json` inside each destination with `revision`, `family`, `archives`, and the final recursive file inventory.

The public entry is:

```powershell
param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$CacheDirectory,
  [string]$LockPath = (Join-Path $PSScriptRoot "llama-windows-runtime-lock.json")
)
```

Use `Invoke-WebRequest -UseBasicParsing`, `Get-FileHash -Algorithm SHA256`, and `Expand-Archive`. Resolve and validate the CPU/CUDA destinations before removing or replacing either family; never remove the caller's output root.

- [ ] **Step 5: Ignore downloaded archives, not the lock or scripts**

Add only the staging cache convention to `.gitignore`:

```gitignore
/artifacts/llama-runtime-cache/
```

- [ ] **Step 6: Run the tests**

Run: `node --test scripts/stage-llama-windows-runtimes.test.cjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add .gitignore scripts/llama-windows-runtime-lock.json scripts/stage-llama-windows-runtimes.ps1 scripts/stage-llama-windows-runtimes.test.cjs
git commit -m "build: pin isolated llama CPU and CUDA runtimes"
```

### Task 2: Resolve and verify both packaged runtime families

**Files:**
- Modify: `electron/captions/local-inference-paths.js`
- Modify: `electron/captions/local-inference-paths.test.cjs`
- Modify: `electron/captions/local-inference-supervisor.js`
- Modify: `electron/captions/local-inference-supervisor.test.cjs`

- [ ] **Step 1: Write failing path and readiness tests**

Change the path tests to require:

```js
assert.equal(paths.llamaCpuBinaryPath,
  'C:\\repo\\artifacts\\local-inference-host\\llama\\cpu\\llama-server.exe');
assert.equal(paths.llamaCudaBinaryPath,
  'C:\\repo\\artifacts\\local-inference-host\\llama\\cuda\\llama-server.exe');
```

Add supervisor readiness cases proving:

- a verified model plus CPU binary is ready when CUDA is absent;
- CUDA without CPU is not ready;
- an installed model is not marked GPU-ready until runtime evidence exists.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test electron/captions/local-inference-paths.test.cjs electron/captions/local-inference-supervisor.test.cjs`

Expected: FAIL because only `llamaBinaryPath` exists.

- [ ] **Step 3: Return isolated paths**

Replace `llamaBinaryPath` with:

```js
llamaCpuBinaryPath: path.win32.join(
  runtimeRoot, 'llama', 'cpu', 'llama-server.exe',
),
llamaCudaBinaryPath: path.win32.join(
  runtimeRoot, 'llama', 'cuda', 'llama-server.exe',
),
```

- [ ] **Step 4: Make CPU the installed-runtime requirement**

Change supervisor constructor/readiness inputs to `llamaCpuBinaryPath` and `llamaCudaBinaryPath`. HY-MT2 readiness requires the verified model and CPU runtime. CUDA presence is an optional acceleration capability and cannot make an otherwise broken installation ready.

Preserve backward-compatible dependency injection in tests only by accepting an explicitly injected `translationRuntime`; do not retain a production single-path alias.

- [ ] **Step 5: Run focused tests**

Run: `node --test electron/captions/local-inference-paths.test.cjs electron/captions/local-inference-supervisor.test.cjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add electron/captions/local-inference-paths.js electron/captions/local-inference-paths.test.cjs electron/captions/local-inference-supervisor.js electron/captions/local-inference-supervisor.test.cjs
git commit -m "refactor: isolate llama runtime family paths"
```

### Task 3: Add a bounded CUDA runtime probe

**Files:**
- Create: `electron/captions/llama-runtime-probe.js`
- Create: `electron/captions/llama-runtime-probe.test.cjs`

- [ ] **Step 1: Write failing parser and lifecycle tests**

Cover:

- `CUDA0: NVIDIA RTX 3000 Ada Generation Laptop GPU` becomes `{ actualDevice: 'CUDA0', deviceName: 'NVIDIA RTX 3000 Ada Generation Laptop GPU' }`;
- a CPU-only/empty device list returns `cuda_device_unavailable`;
- non-NVIDIA devices are rejected;
- spawn error, nonzero exit, oversized output, and timeout return stable fallback codes;
- two calls use one cached probe;
- `invalidate()` causes exactly one new probe;
- timeout kills the child and leaves no live process.

Use the public contract:

```js
const probe = new LlamaCudaProbe({
  binaryPath: 'C:\\runtime\\cuda\\llama-server.exe',
  spawn,
  timeoutMs: 5_000,
});
const result = await probe.probe();
// { usable, requestedDevice: 'CUDA_AUTO', actualDevice, deviceName, fallbackReason }
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node --test electron/captions/llama-runtime-probe.test.cjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict device parsing**

Export a pure parser:

```js
function parseCudaDevices(output) {
  const matches = [...String(output || '').matchAll(/^\s*(CUDA\d+)\s*:\s*(.+?)\s*$/gim)];
  const devices = matches
    .map((match) => ({ actualDevice: match[1].toUpperCase(), deviceName: match[2].trim().slice(0, 160) }))
    .filter((device) => /\bNVIDIA\b/i.test(device.deviceName));
  return devices;
}
```

The probe must spawn only the packaged CUDA executable with `['--list-devices']`, `cwd` set to its CUDA directory, `windowsHide: true`, and piped stdout/stderr. Bound combined output to 16 KiB. Resolve only after a normal exit. On timeout, kill before resolving `cuda_probe_timeout`.

- [ ] **Step 4: Add cache and invalidation**

Cache the completed result and any in-flight promise. `invalidate()` clears both only after killing any active probe. Do not turn a failed probe into an exception; return a typed unavailable result so the controller can start CPU.

- [ ] **Step 5: Run focused tests**

Run: `node --test electron/captions/llama-runtime-probe.test.cjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add electron/captions/llama-runtime-probe.js electron/captions/llama-runtime-probe.test.cjs
git commit -m "feat: add bounded llama CUDA capability probe"
```

### Task 4: Parameterize one llama.cpp server with truthful runtime evidence

**Files:**
- Modify: `electron/captions/llama-translation-client.js`
- Modify: `electron/captions/llama-translation-client.test.cjs`

- [ ] **Step 1: Replace the CPU-only test with CPU and CUDA launch tests**

Instantiate the server with an explicit immutable runtime descriptor:

```js
const cudaRuntime = {
  family: 'cuda',
  runtime: 'llama.cpp-b9940-cuda12.4',
  requestedDevice: 'CUDA_AUTO',
  launchArgs: ['--device', 'CUDA0', '--gpu-layers', 'auto', '--fit', 'on'],
};
const cpuRuntime = {
  family: 'cpu',
  runtime: 'llama.cpp-b9940-cpu',
  requestedDevice: 'CPU',
  launchArgs: ['--gpu-layers', '0'],
};
```

Require CPU and CUDA to retain the common loopback/context arguments and require CUDA to run with `cwd` inside the CUDA directory.

Add evidence tests for representative bounded stderr:

```text
ggml_cuda_init: found 1 CUDA devices:
  Device 0: NVIDIA RTX 3000 Ada Generation Laptop GPU
load_tensors: offloaded 29/29 layers to GPU
```

Expected health/result: `actualDevice: 'CUDA0'`, the bounded `deviceName`, and `offload: 'full'`. Add `12/29` => `partial`, CPU => `none`, and missing CUDA evidence => startup failure `local_translation_device_unverified`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test electron/captions/llama-translation-client.test.cjs`

Expected: FAIL because the client hardcodes CPU and has no evidence parser.

- [ ] **Step 3: Parameterize launch arguments and provenance**

The common launch list remains:

```js
const args = [
  '-m', this.modelPath,
  '--host', '127.0.0.1',
  '--port', String(this.port),
  '--no-webui', '-c', '2048',
  '--log-colors', 'off',
  ...this.runtimeDescriptor.launchArgs,
];
```

Parse device/offload evidence only from the bounded process output after `/health` reports ready. For CPU, set `actualDevice: 'CPU'` and `offload: 'none'`. For CUDA, require device evidence before marking ready; never infer GPU from launch arguments.

- [ ] **Step 4: Return the same evidence from health and translations**

Both response shapes include:

```js
{
  requestedDevice: this.runtimeDescriptor.requestedDevice,
  actualDevice: this.provenance.actualDevice,
  deviceName: this.provenance.deviceName,
  offload: this.provenance.offload,
  fallbackReason: null,
  loadMs: this.loadMs,
}
```

Keep prompt masking, glossary behavior, temperature, output limit, and request timeout byte-for-byte equivalent to the current behavior.

- [ ] **Step 5: Make process shutdown bounded and observable**

`stop()` sends a normal kill, waits up to 2 seconds for `close`, and then force-kills if the injected child API exposes that capability. It clears `started`, `child`, port, and provenance even when the process already exited.

- [ ] **Step 6: Run focused tests**

Run: `node --test electron/captions/llama-translation-client.test.cjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add electron/captions/llama-translation-client.js electron/captions/llama-translation-client.test.cjs
git commit -m "refactor: make llama translation runtime device-aware"
```

### Task 5: Add session-stable automatic CUDA selection and CPU fallback

**Files:**
- Create: `electron/captions/hy-mt2-runtime-controller.js`
- Create: `electron/captions/hy-mt2-runtime-controller.test.cjs`

- [ ] **Step 1: Write failing state-machine tests**

Use fake probe/servers to cover every transition:

1. Feature flag off -> CPU directly, no probe.
2. Usable CUDA -> CUDA start, no CPU start.
3. No device/corrupt runtime/probe timeout -> CPU with the exact probe fallback code.
4. CUDA startup failure or unverified evidence -> stop CUDA before starting CPU.
5. CUDA request crash -> invalidate the probe, increment generation, start CPU once.
6. A final request is retried on CPU and returns authoritative CPU provenance.
7. A preview request from the retired generation rejects with an `AbortError` and is not retried.
8. A late CUDA response is rejected after generation changes.
9. Concurrent failed finals share one fallback promise and each retries at most once.
10. CPU failure after CUDA failure returns the existing local translation error.
11. The controller never attempts CUDA again in the same session.
12. A new session can probe/attempt CUDA again.

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node --test electron/captions/hy-mt2-runtime-controller.test.cjs`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement the controller contract**

Use these public methods so it remains a drop-in translation object for `HybridLocalInferenceClient`:

```js
class HyMt2RuntimeController extends EventEmitter {
  beginSession(sessionId) {}
  async start() {}
  health() {}
  async translate(type, payload, options) {}
  async stop() {}
}
```

Internal state is exactly:

```js
this.sessionId = null;
this.generation = 0;
this.activeFamily = null;
this.activeServer = null;
this.fallbackReason = null;
this.cudaRetired = false;
this.fallbackPromise = null;
```

- [ ] **Step 4: Implement one-way startup fallback**

When enabled, call the cached probe. A usable result attempts CUDA. Any CUDA start/evidence error is mapped to a stable reason, the CUDA server is stopped, the probe is invalidated, and CPU is started. When disabled or unavailable, start CPU directly. If CPU fails, rethrow the existing local-translation error with `fallbackReason` attached as diagnostic metadata only.

- [ ] **Step 5: Implement generation-safe request fallback**

Capture `requestGeneration` before dispatch. After resolve, reject if it differs from the current generation. On a device-class CUDA failure, serialize `fallbackToCpu()` through `fallbackPromise`. Retry only `translate.final`; turn preview retirement into an `AbortError`. The CPU retry must preserve `utteranceId`, `sourceRevision`, prompt inputs, and caller signal.

- [ ] **Step 6: Merge controller provenance**

`health()` and results preserve server evidence and add controller fallback. When CPU was selected after CUDA was requested, the controller must retain the original request intent rather than copying the CPU server's request value:

```js
{
  ...serverValue,
  requestedDevice: this.fallbackReason ? 'CUDA_AUTO' : serverValue.requestedDevice,
  fallbackReason: this.fallbackReason,
}
```

Do not replace `requestedDevice: 'CUDA_AUTO'` after fallback; `actualDevice: 'CPU'` plus `fallbackReason` describes what happened truthfully. Emit a sanitized `status` event after initial selection and after fallback so Settings can update while the meeting is active.

- [ ] **Step 7: Run focused tests**

Run: `node --test electron/captions/hy-mt2-runtime-controller.test.cjs`

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add electron/captions/hy-mt2-runtime-controller.js electron/captions/hy-mt2-runtime-controller.test.cjs
git commit -m "feat: select CUDA with one-way HY-MT2 CPU fallback"
```

### Task 6: Wire the controller into the existing local pipeline

**Files:**
- Modify: `electron/captions/local-inference-supervisor.js`
- Modify: `electron/captions/local-inference-supervisor.test.cjs`
- Modify: `electron/captions/local-inference-runtime.js`
- Modify: `electron/captions/local-inference-runtime.test.cjs`
- Modify: `electron/captions/hybrid-local-inference-client.test.cjs`
- Modify: `electron/captions-main.js`

- [ ] **Step 1: Write failing composition tests**

Require the runtime bootstrap to pass both binary paths and `cudaEnabled` into the supervisor. Require the supervisor to construct one controller containing two `LlamaTranslationServer` instances and one `LlamaCudaProbe`. Require `prepare(models, sessionId)` to call `beginSession(sessionId)` before `start()`. Require controller `status` events to update `lastModels`, emit a supervisor `model-status` event, and cause `LocalModelService.publishStatus()` to publish a new renderer snapshot.

Add hybrid-client tests proving health preserves `CUDA0`, `offload`, and `fallbackReason` without changing translation routing.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test electron/captions/local-inference-runtime.test.cjs electron/captions/local-inference-supervisor.test.cjs electron/captions/hybrid-local-inference-client.test.cjs`

Expected: FAIL because composition still creates one CPU-only server.

- [ ] **Step 3: Construct the runtime graph in the supervisor**

When no `translationRuntime` is injected, create:

```js
const cpuServer = new LlamaTranslationServer({
  binaryPath: llamaCpuBinaryPath,
  modelPath: hyMt2ModelPath,
  runtimeDescriptor: CPU_RUNTIME,
});
const cudaServer = llamaCudaBinaryPath
  ? new LlamaTranslationServer({
      binaryPath: llamaCudaBinaryPath,
      modelPath: hyMt2ModelPath,
      runtimeDescriptor: CUDA_RUNTIME,
    })
  : null;
this.translationRuntime = new HyMt2RuntimeController({
  enabled: cudaEnabled,
  probe: cudaServer ? new LlamaCudaProbe({ binaryPath: llamaCudaBinaryPath }) : null,
  cudaServer,
  cpuServer,
});
```

Use `translationRuntime` consistently in hybrid-client creation, prepare, restart, health, and dispose. Native Whisper host restart must not restart a healthy translation process.

In `readiness()`, prefer `translationRuntime.health()` for HY-MT2 over the older `lastModels` snapshot whenever the controller exists. Subscribe once to controller status in the supervisor constructor:

```js
this.translationRuntime.on?.('status', (model) => {
  this.lastModels.set('hy-mt2-1.8b', model);
  this.emit('model-status', model);
});
```

In `createLocalInferenceRuntime`, subscribe `supervisor.on('model-status', () => service.publishStatus())` after both objects exist, and remove that listener during disposal through the existing supervisor lifetime.

- [ ] **Step 4: Inject the development rollout flag at the app boundary**

In `captions-main.js`, pass:

```js
cudaEnabled:
  process.platform === 'win32' && process.env.TWINSCRIPT_HYMT2_CUDA === '1',
```

Do not read this environment variable in the renderer and do not persist it in settings.

- [ ] **Step 5: Run focused tests**

Run: `node --test electron/captions/local-inference-runtime.test.cjs electron/captions/local-inference-supervisor.test.cjs electron/captions/hybrid-local-inference-client.test.cjs`

Expected: PASS.

- [ ] **Step 6: Run local pipeline regression tests**

Run: `node --test electron/captions/processing-configuration.test.cjs electron/captions/translation-policy.test.cjs electron/captions/local-privacy.test.cjs`

Expected: PASS; model authority and offline privacy are unchanged.

- [ ] **Step 7: Commit**

```powershell
git add electron/captions-main.js electron/captions/local-inference-runtime.js electron/captions/local-inference-runtime.test.cjs electron/captions/local-inference-supervisor.js electron/captions/local-inference-supervisor.test.cjs electron/captions/hybrid-local-inference-client.test.cjs
git commit -m "feat: wire automatic CUDA translation into local pipeline"
```

### Task 7: Carry device and fallback provenance through records and renderer IPC

**Files:**
- Modify: `electron/captions/translation-backends.js`
- Modify: `electron/captions/translation-backends.test.cjs`
- Modify: `electron/captions/caption-session-manager.js`
- Modify: `electron/captions/caption-session-manager.test.cjs`
- Modify: `electron/captions/local-model-service.js`
- Modify: `electron/captions/local-model-service.test.cjs`
- Modify: `src/captions/types.ts`

- [ ] **Step 1: Write failing provenance tests**

Require the backend result to preserve:

```js
{
  requestedDevice: 'CUDA_AUTO',
  actualDevice: 'CUDA0',
  deviceName: 'NVIDIA RTX 3000 Ada Generation Laptop GPU',
  offload: 'partial',
  fallbackReason: null,
  inferenceMs: 410,
}
```

Require session records to persist this under both current and final normalization metadata. Require renderer status to accept only `CUDA0`/`CPU` as actual translation devices, only the four offload values, a device name capped at 160 characters, and fallback codes matching `^[a-z0-9_]{1,80}$`. Malformed values must become `null`/`unknown`, never pass through.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test electron/captions/translation-backends.test.cjs electron/captions/caption-session-manager.test.cjs electron/captions/local-model-service.test.cjs`

Expected: FAIL because only `actualDevice` crosses all boundaries today.

- [ ] **Step 3: Extend backend and record contracts**

Return the six fields from `LocalHyMt2Backend.normalize`. Extend `CaptionEvent.provider` with optional current/final fields:

```ts
normalizationRequestedDevice?: string;
normalizationDeviceName?: string;
normalizationOffload?: 'full' | 'partial' | 'none' | 'unknown';
normalizationFallbackReason?: string;
finalNormalizationRequestedDevice?: string;
finalNormalizationDeviceName?: string;
finalNormalizationOffload?: 'full' | 'partial' | 'none' | 'unknown';
finalNormalizationFallbackReason?: string;
```

Assign them beside the existing normalization model/runtime/device fields only after the result passes the existing source-revision and abort checks.

- [ ] **Step 4: Extend renderer-safe model state**

Add to `LocalModelState`:

```ts
actualDevice: 'NPU' | 'CUDA0' | 'CPU' | null;
requestedDevice?: 'NPU' | 'CUDA_AUTO' | 'CPU' | null;
deviceName?: string | null;
offload?: 'full' | 'partial' | 'none' | 'unknown';
fallbackReason?: string | null;
loadMs?: number | null;
```

Keep Whisper's NPU value valid. Replace the generic `GPU` sanitizer with model-aware sanitizers; never expose raw stderr or filesystem paths.

- [ ] **Step 5: Run focused tests**

Run: `node --test electron/captions/translation-backends.test.cjs electron/captions/caption-session-manager.test.cjs electron/captions/local-model-service.test.cjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add electron/captions/translation-backends.js electron/captions/translation-backends.test.cjs electron/captions/caption-session-manager.js electron/captions/caption-session-manager.test.cjs electron/captions/local-model-service.js electron/captions/local-model-service.test.cjs src/captions/types.ts
git commit -m "feat: preserve HY-MT2 runtime provenance"
```

### Task 8: Present concise, evidence-backed device status in Settings

**Files:**
- Modify: `src/captions/LocalModelInstallCard.tsx`
- Modify: `src/captions/LocalModelInstallCard.test.tsx`
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/ControlApp.test.tsx`
- Modify: `src/captions/captions.scss`

- [ ] **Step 1: Write failing UI tests for every status**

Cover exact user-facing copy:

- `CUDA0` + `full` -> `NVIDIA GPU`.
- `CUDA0` + `partial` -> `NVIDIA GPU · partial offload`.
- `CPU` + an attempted-CUDA failure reason -> `CPU fallback` and a keyboard-accessible details disclosure containing a friendly mapped reason.
- `CPU` + `cuda_device_unavailable` -> `CPU`, because no usable NVIDIA device was available to attempt acceleration.
- `CPU` without attempted CUDA -> `CPU`.
- Installed but never run -> `Uses NVIDIA GPU when available; CPU fallback included`.
- Raw fallback code, stderr, runtime path, and `CUDA0` never appear as primary UI copy.

The pipeline-choice heading and model-install card must use the same formatter so they cannot disagree.

- [ ] **Step 2: Run focused UI tests and confirm failure**

Run: `npx vitest run src/captions/LocalModelInstallCard.test.tsx src/captions/ControlApp.test.tsx`

Expected: FAIL because the UI currently renders raw `actualDevice` and says CPU by default.

- [ ] **Step 3: Add one shared renderer formatter**

Create an exported pure formatter in `LocalModelInstallCard.tsx` or a nearby existing caption UI utility:

```ts
export const translationDeviceLabel = (model: LocalModelState) => {
  if (model.actualDevice === 'CUDA0') {
    return model.offload === 'partial'
      ? 'NVIDIA GPU · partial offload'
      : 'NVIDIA GPU';
  }
  if (model.actualDevice === 'CPU' &&
      model.fallbackReason &&
      model.fallbackReason !== 'cuda_device_unavailable') return 'CPU fallback';
  if (model.actualDevice === 'CPU') return 'CPU';
  return 'Uses NVIDIA GPU when available; CPU fallback included';
};
```

Map stable fallback codes to short copy such as `The NVIDIA runtime could not allocate the model, so Twinscript continued locally on the CPU.` Unknown codes use `NVIDIA acceleration was unavailable, so Twinscript continued locally on the CPU.`

- [ ] **Step 4: Add disclosure without clustering the card**

Place the status label on the existing metadata line. Render `<details>` only for CPU fallback, below that line, with at least 8 px vertical separation and the existing muted text style. Do not add another button row or a GPU selector.

- [ ] **Step 5: Run focused tests and build**

Run: `npx vitest run src/captions/LocalModelInstallCard.test.tsx src/captions/ControlApp.test.tsx`

Expected: PASS.

Run: `npm run build`

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit**

```powershell
git add src/captions/LocalModelInstallCard.tsx src/captions/LocalModelInstallCard.test.tsx src/captions/ControlApp.tsx src/captions/ControlApp.test.tsx src/captions/captions.scss
git commit -m "feat: show verified HY-MT2 acceleration status"
```

### Task 9: Build, verify, and package complete CPU and CUDA runtime families

**Files:**
- Modify: `scripts/build-local-inference-host.ps1`
- Modify: `scripts/verify-local-inference-host.ps1`
- Create: `scripts/verify-local-inference-runtime-layout.test.cjs`
- Modify: `forge.config.js`

- [ ] **Step 1: Write failing manifest/layout tests**

Require runtime manifest schema 2 with:

```json
{
  "schemaVersion": 2,
  "runtime": "openvino-genai-2026.3+llama.cpp-b9940",
  "runtimeFamilies": {
    "cpu": { "revision": "b9940", "entryPoint": "llama/cpu/llama-server.exe" },
    "cuda": { "revision": "b9940", "entryPoint": "llama/cuda/llama-server.exe" }
  },
  "files": []
}
```

The test must fail if either entry point is absent, revisions differ, any file listed by a family is outside that family directory, or a manifest file is missing from the global hashed inventory.

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test scripts/verify-local-inference-runtime-layout.test.cjs`

Expected: FAIL because the current manifest uses schema 1 and `llama/` is not isolated.

- [ ] **Step 3: Update the build script inputs and manifest**

Replace `-LlamaRoot` with:

```powershell
[string]$LlamaCpuRoot,
[string]$LlamaCudaRoot,
[string]$LlamaRevision = "b9940"
```

Copy each directory recursively to `llama/cpu` or `llama/cuda`. Require both when producing a CUDA-enabled release artifact; allow CPU-only development builds only when an explicit `-CpuOnly` switch is present. Generate schema 2 after every file is staged.

- [ ] **Step 4: Extend verification**

`verify-local-inference-host.ps1` must:

- verify every global file hash and size;
- require both family metadata files for a release artifact;
- require the same pinned revision;
- launch CPU `--list-devices` and reject any CUDA device;
- launch CUDA `--list-devices` with a 10-second timeout, accepting either a valid NVIDIA CUDA device or the stable unsupported-driver/no-device outcome on build hosts;
- always terminate the probe process;
- continue the existing native-host hello/health/shutdown test.

- [ ] **Step 5: Keep Forge packaging fail-closed**

Retain `artifacts/local-inference-host` as one `extraResource`, but add a `packageAfterCopy` validation that reads schema 2 and requires both family entry points before a Windows release package can finish. Do not copy runtime files through separate Forge entries.

- [ ] **Step 6: Stage the pinned runtimes and rebuild the manifest**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/stage-llama-windows-runtimes.ps1 -OutputDirectory artifacts/local-inference-host/llama -CacheDirectory artifacts/llama-runtime-cache
```

Expected: both `llama/cpu/llama-server.exe` and `llama/cuda/llama-server.exe` exist and each has its own dependent DLLs.

Run the existing host build with the staged family roots and the installed OpenVINO path used by this worktree. Expected: schema 2 manifest generated with both families.

- [ ] **Step 7: Run layout and host verification**

Run: `node --test scripts/verify-local-inference-runtime-layout.test.cjs`

Expected: PASS.

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-local-inference-host.ps1 -HostDirectory artifacts/local-inference-host`

Expected: PASS; CPU and CUDA families remain isolated and the native host exits cleanly.

- [ ] **Step 8: Commit scripts and source metadata only**

Do not add staged binaries or downloaded archives if they are already ignored by repository policy.

```powershell
git add forge.config.js scripts/build-local-inference-host.ps1 scripts/verify-local-inference-host.ps1 scripts/verify-local-inference-runtime-layout.test.cjs
git commit -m "build: verify packaged CPU and CUDA runtime families"
```

### Task 10: Add real-runtime correctness, fallback, and performance gates

**Files:**
- Modify: `scripts/smoke-local-inference.cjs`
- Modify: `native/local-inference-host/tests/hymt2_server_smoke.cjs`
- Create: `scripts/benchmark-hymt2-runtimes.cjs`
- Create: `scripts/benchmark-hymt2-runtimes.test.cjs`
- Create: `artifacts/local-inference/hymt2-cuda.json` (generated validation evidence; commit only if repository policy tracks feasibility evidence)

- [ ] **Step 1: Write failing benchmark-result tests**

The pure summarizer must require:

```js
{
  revision: 'b9940',
  modelSha256: 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699',
  cpu: { medianInferenceMs: 0, p95VisibleMs: 0 },
  cuda: { medianInferenceMs: 0, p95VisibleMs: 0 },
  medianImprovement: 0,
  qualityPassed: false,
  passed: false
}
```

`passed` is true only when the same six bilingual cases pass, protected literals survive, CUDA evidence is `CUDA0`, warm median inference improves by at least 30%, and CUDA p95 visible latency is no worse than CPU p95.

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --test scripts/benchmark-hymt2-runtimes.test.cjs`

Expected: FAIL because the benchmark module does not exist.

- [ ] **Step 3: Update smoke scripts for either actual family**

Use separate environment variables:

```text
TWINSCRIPT_LLAMA_CPU_SERVER
TWINSCRIPT_LLAMA_CUDA_SERVER
TWINSCRIPT_HYMT2_MODEL
TWINSCRIPT_LOCAL_HOST
TWINSCRIPT_WHISPER_MODEL
TWINSCRIPT_WHISPER_PCM24
```

The combined smoke must require Whisper `NPU`, HY-MT2 `CUDA0` when the CUDA flag is enabled and usable, and HY-MT2 `CPU` when CUDA is intentionally disabled. Add a run with an injected failing CUDA binary path to prove local CPU fallback without any OpenAI client.

- [ ] **Step 4: Implement the benchmark runner**

Run one warm-up plus at least ten measured repetitions of all six existing EN/ZH/mixed cases on each family. Record process load, model inference, request-to-response, and finalized-source-to-accepted-result latency. For the user-visible measurement, dispatch the final through `CaptionSessionManager` and stop the timer in its `onCaption` callback when the matching target first arrives with `status: 'final'`; do not substitute raw HTTP completion time. Write JSON atomically only after both families finish and all quality assertions pass.

- [ ] **Step 5: Run unit and real-runtime smoke tests**

Run: `node --test scripts/benchmark-hymt2-runtimes.test.cjs`

Expected: PASS.

Run the updated HY-MT2 smoke once with CPU and once with CUDA paths. Expected: both directions preserve names, numbers, units, and protected literals; provenance matches runtime evidence.

Run the combined local pipeline smoke with `TWINSCRIPT_HYMT2_CUDA=1`. Expected: Whisper reports NPU; translation reports CUDA0 or an explicit CPU fallback reason; no cloud credential is required.

- [ ] **Step 6: Run the hardware benchmark**

Run the benchmark on the RTX 3000 Ada laptop once with normal VRAM availability and once while constraining free VRAM enough to exercise partial offload or CPU fallback.

Expected release gate: warm CUDA median inference is at least 30% faster than CPU and p95 user-visible final latency does not regress. If this gate fails, keep the feature flag disabled and record the measured evidence; do not weaken the threshold.

- [ ] **Step 7: Commit**

```powershell
git add scripts/smoke-local-inference.cjs native/local-inference-host/tests/hymt2_server_smoke.cjs scripts/benchmark-hymt2-runtimes.cjs scripts/benchmark-hymt2-runtimes.test.cjs
git commit -m "test: gate HY-MT2 CUDA correctness and latency"
```

### Task 11: Complete regression, package, privacy, and user-review validation

**Files:**
- Modify only if a failing verification reveals a scoped defect.
- Update: `docs/superpowers/specs/2026-08-25-hy-mt2-cuda-acceleration-design.md` status to `Implemented` only after every gate passes.

- [ ] **Step 1: Run all main-process and native contract tests**

Run: `npm run test:captions`

Expected: PASS with no skipped CUDA controller unit tests.

- [ ] **Step 2: Run renderer tests and production build**

Run: `npx vitest run src/captions/ControlApp.test.tsx src/captions/LocalModelInstallCard.test.tsx`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 3: Run privacy and authority regression explicitly**

Run: `node --test electron/captions/local-privacy.test.cjs electron/captions/processing-configuration.test.cjs electron/captions/translation-policy.test.cjs electron/captions/caption-session-manager.test.cjs`

Expected: PASS. Fully local mode starts without an OpenAI key, CUDA fallback never constructs a cloud client, and the selected final model remains authoritative.

- [ ] **Step 4: Build and inspect the Windows package**

Run: `npm run package`

Expected: PASS. Inspect the package resources and require:

```text
local-inference-host/llama/cpu/llama-server.exe
local-inference-host/llama/cuda/llama-server.exe
local-inference-host/runtime-manifest.json
```

Run the signature verifier used by the release pipeline. Expected: every packaged executable and DLL satisfies the repository's signing policy.

- [ ] **Step 5: Perform clean-install offline user review**

On compatible NVIDIA hardware:

1. Disconnect network after models are installed/adopted.
2. Start a fully local Whisper + HY-MT2 meeting without an OpenAI key.
3. Confirm Settings reports `NVIDIA GPU` or `NVIDIA GPU · partial offload` only after a translation has run.
4. Speak one English engineering sentence and one Chinese engineering sentence.
5. Confirm final bilingual captions appear, saved records identify HY-MT2 and the actual device, and Stop completes promptly.
6. Force CUDA unavailability, start a new meeting, and confirm `CPU fallback` with friendly details, correct captions, and no network request.

On a CPU-only Windows machine, repeat startup and one bilingual utterance. Expected: HY-MT2 runs on CPU with no misleading GPU label.

- [ ] **Step 6: Enable Windows automatic acceleration only after gates pass**

After the benchmark, correctness, privacy, package, signature, and clean-install gates pass, replace the development opt-in with a Windows release default plus an emergency kill switch:

```js
cudaEnabled:
  process.platform === 'win32' && process.env.TWINSCRIPT_DISABLE_HYMT2_CUDA !== '1',
```

Add a bootstrap unit test proving the kill switch starts CPU directly. This is the only rollout-policy code change in this step.

- [ ] **Step 7: Mark the design implemented and commit**

```powershell
git add electron/captions-main.js electron/captions/local-inference-runtime.test.cjs docs/superpowers/specs/2026-08-25-hy-mt2-cuda-acceleration-design.md
git commit -m "release: enable verified HY-MT2 CUDA acceleration"
```

## Final self-review checklist

- [ ] Search for stale single-runtime paths: `rg -n "llamaBinaryPath|llama/llama-server|gpu-layers.?0" electron scripts native src` and verify every remaining occurrence is intentional CPU configuration or migration documentation.
- [ ] Search for misleading device copy: `rg -n "GPU ready|Runs locally on CPU|actualDevice \|\| 'CPU'" electron src` and verify UI copy is evidence-backed.
- [ ] Search for placeholders: `rg -n "TODO|FIXME|TBD|placeholder|your-path|example-hash" electron scripts native src docs/superpowers/specs/2026-08-25-hy-mt2-cuda-acceleration-design.md` and remove any implementation placeholders introduced by this work.
- [ ] Confirm TypeScript and JavaScript contracts agree on `requestedDevice`, `actualDevice`, `deviceName`, `offload`, `fallbackReason`, `loadMs`, and `inferenceMs`.
- [ ] Confirm CPU remains packaged, verified, and independently launchable.
- [ ] Confirm no device transition changes `finalTranslationModel`, constructs Luna, or relaxes the credential/privacy gate.
- [ ] Confirm all child processes have bounded startup, bounded output, bounded shutdown, and no orphaned loopback listener.
- [ ] Confirm CUDA and CPU use the identical HY-MT2 model hash, prompt, glossary constraints, protected-token behavior, temperature, context, and maximum output length.
