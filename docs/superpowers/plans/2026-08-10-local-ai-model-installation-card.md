# Local AI Model Installation Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated Settings card that independently installs, verifies, repairs, and removes Whisper and HY-MT2 from a signed app-controlled model catalog while preserving the latest audio-sampling fix from `main`.

**Architecture:** Electron main owns a signed catalog loader, the existing `LocalModelManager`, and a new `LocalModelService` that composes download lifecycle with native-runtime readiness. Narrow IPC methods and a status event expose that service to a focused React card; the renderer never receives paths or download URLs. `LocalInferenceSupervisor` consumes the manager's verified state so meeting readiness and the installation card cannot disagree.

**Tech Stack:** Electron 40 main/preload IPC, Node.js `fetch`/Web Streams/crypto/fs, React 19, TypeScript, Vitest/Testing Library, Node `node:test`, Electron Forge, Ed25519 and SHA-256.

---

## File structure

**Create:**

- `electron/captions/local-model-manifest-loader.js` — locate and load the release catalog, signature, and public key; return a safe unavailable state when absent.
- `electron/captions/local-model-manifest-loader.test.cjs` — packaged signature, development fixture, and unavailable-state coverage.
- `electron/captions/local-model-service.js` — compose manager lifecycle, runtime readiness, active-meeting locks, and status events.
- `electron/captions/local-model-service.test.cjs` — service state composition and operation/event tests.
- `electron/captions/local-model-runtime.js` — construct catalog, paths, manager, supervisor, and service without coupling startup logic to the Electron entry point.
- `electron/captions/local-model-runtime.test.cjs` — dependency-order, unavailable-catalog, and readiness-delegation tests.
- `electron/captions/local-model-ipc.test.cjs` — sender validation, independent operations, removal confirmation, and broadcasts.
- `src/captions/LocalModelInstallCard.tsx` — presentational card with two independent rows and accessible actions.
- `src/captions/LocalModelInstallCard.test.tsx` — row-state, progress, action, and accessibility tests.
- `scripts/release/sign-local-model-manifest.cjs` — offline release utility; private keys are inputs and never enter the repository.
- `scripts/release/local-model-manifest.test.cjs` — signing-output verification and invalid-input tests.
- `resources/local-models/README.md` — exact release artifact contract; no unsigned catalog or placeholder URL.

**Modify:**

- `electron/captions/test-discovery.test.cjs` — preserve native-host discovery while adopting the live audio-capture suite from `main`.
- `vitest.config.ts` — include the modern-audio regression tests from `main`.
- `src/captions/audioCapture.ts` — receive `main`'s visible compatibility-path warning.
- `src/lib/modern-audio/BaseAudioRecorder.ts` — receive `main`'s transport reporting and fallback resampler.
- `src/lib/modern-audio/worklets/audio-recorder-worklet-processor.js` — receive the restored colocated worklet.
- `src/lib/modern-audio/captureTransport.test.ts` — receive the sampling regression suite.
- `electron/captions/local-model-manifest.js` — validate renderer metadata and launch-relative paths in addition to file integrity fields.
- `electron/captions/local-model-manifest.test.cjs` — pin the expanded schema and reject unsafe launch paths.
- `electron/captions/local-model-manager.js` — stream resumable downloads, expose lifecycle phases, fully verify, repair, and report installed/partial state.
- `electron/captions/local-model-manager.test.cjs` — independent models, progress, resume, Range fallback, verify, repair, meeting lock, and removal.
- `electron/captions/local-inference-paths.js` — derive installed paths from catalog versions instead of duplicated version constants.
- `electron/captions/local-inference-paths.test.cjs` — catalog-derived paths.
- `electron/captions/local-inference-supervisor.js` — use the service's verified model readiness hook.
- `electron/captions/local-inference-supervisor.test.cjs` — prevent filesystem/marker disagreement.
- `electron/captions/caption-session-manager.js` — expose a read-only `isActive()` lifecycle query.
- `electron/captions/caption-foundation.test.cjs` — pin `isActive()` and selected-model startup behavior.
- `electron/captions/register-caption-ipc.js` — add local-model status/install/verify/remove IPC.
- `electron/captions-preload.js` — expose narrow methods and the allowlisted status subscription.
- `electron/captions-main.js` — construct catalog, manager, supervisor, and service in dependency order.
- `src/captions/types.ts` — add typed model lifecycle snapshots.
- `src/electron.d.ts` — type the new preload contract.
- `src/captions/ControlApp.tsx` — load/subscribe to model state, run actions, and link pipeline warnings to rows.
- `src/captions/ControlApp.test.tsx` — card integration, independent readiness, progress, errors, locks, and focus recovery.
- `src/captions/captions.css` — card rows, states, progress, responsive layout, focus, and reduced motion.
- `forge.config.js` — assert the release catalog contract is packaged under the expected resource path when present.

## Task 1: Integrate and prove `main`'s audio-sampling fix

**Files:**

- Modify: `electron/captions/test-discovery.test.cjs`
- Modify: `vitest.config.ts`
- Modify: `src/captions/audioCapture.ts`
- Modify: `src/lib/modern-audio/BaseAudioRecorder.ts`
- Create from `main`: `src/lib/modern-audio/worklets/audio-recorder-worklet-processor.js`
- Create from `main`: `src/lib/modern-audio/captureTransport.test.ts`

- [ ] **Step 1: Verify the expected branch relation before mutation**

Run:

```powershell
git log --oneline --left-right --cherry-pick HEAD...main
```

Expected: `40f8f00b fix(audio): gibberish captions were 48 kHz audio in a 24 kHz session` is the only commit on the `main` side.

- [ ] **Step 2: Merge `main` into the feature branch**

Run:

```powershell
git merge --no-commit --no-ff main
```

Expected: the audio files merge automatically; `electron/captions/test-discovery.test.cjs` may require a content resolution because this branch also added native-host test discovery.

- [ ] **Step 3: Resolve test discovery by preserving both live paths**

The final arrays/assertions must contain exactly:

```js
const NODE_TEST_GLOBS = Object.freeze([
  'electron/captions/*.test.cjs',
  'native/local-inference-host/tests/*.test.cjs',
  'scripts/release/*.test.cjs',
]);

assert.deepEqual(vitestArray('include'), [
  'src/captions/**/*.test.{ts,tsx}',
  'src/lib/modern-audio/**/*.test.{ts,tsx}',
]);

for (const pattern of vitestArray('include')) {
  assert.ok(!pattern.includes('local-inference'));
  assert.ok(!/^src\/lib\/\*/.test(pattern));
}
```

Run after resolving:

```powershell
git add electron/captions/test-discovery.test.cjs vitest.config.ts src/captions/audioCapture.ts src/lib/modern-audio
git commit --no-edit
```

Expected: one merge commit and no unmerged paths.

- [ ] **Step 4: Run the targeted audio regression tests**

Run:

```powershell
npx vitest run src/lib/modern-audio/captureTransport.test.ts
node --test electron/captions/test-discovery.test.cjs
```

Expected: worklet existence/name, 48-to-24 kHz averaging, no-op same-rate transport, and test discovery all pass.

- [ ] **Step 5: Run capture and local-ingestion regression suites together**

Run:

```powershell
npx vitest run src/captions/audioCapture.test.ts src/lib/modern-audio/captureTransport.test.ts
node --test electron/captions/transcription-backends.test.cjs
```

Expected: the cloud transport warning/resampler and bounded Whisper ingestion pass in the same tree.

## Task 2: Define and load the signed release catalog

**Files:**

- Create: `electron/captions/local-model-manifest-loader.js`
- Create: `electron/captions/local-model-manifest-loader.test.cjs`
- Modify: `electron/captions/local-model-manifest.js`
- Modify: `electron/captions/local-model-manifest.test.cjs`
- Create: `resources/local-models/README.md`

- [ ] **Step 1: Write failing schema tests for the two allowed models and renderer metadata**

Add these fixture values and assertions:

```js
const manifest = {
  schemaVersion: 1,
  runtimeVersion: '2026.2.1',
  models: [
    {
      id: 'whisper-small',
      displayName: 'Whisper',
      purpose: 'Local transcription',
      expectedDevice: 'NPU',
      version: '973afd24965f72e36ca33b3055d56a652f456b4d',
      launchPath: '.',
      license: 'MIT',
      source: 'openai/whisper-small',
      unpackedSize: 258_000_000,
      files: [{ path: 'openvino_encoder_model.xml', url: 'https://models.example.invalid/whisper/openvino_encoder_model.xml', size: 12, sha256: 'a'.repeat(64) }],
    },
    {
      id: 'hy-mt2-1.8b',
      displayName: 'HY-MT2',
      purpose: 'Local translation',
      expectedDevice: 'CPU',
      version: '1cd5208700acedef4ef93019b6cfc148b8522d45',
      launchPath: 'Hy-MT2-1.8B-Q4_K_M.gguf',
      license: 'Apache-2.0',
      source: 'tencent/Hy-MT2-1.8B',
      unpackedSize: 1_130_000_000,
      files: [{ path: 'Hy-MT2-1.8B-Q4_K_M.gguf', url: 'https://models.example.invalid/hymt2/Hy-MT2-1.8B-Q4_K_M.gguf', size: 20, sha256: 'b'.repeat(64) }],
    },
  ],
};

assert.doesNotThrow(() => validateManifest(manifest));
assert.throws(
  () => validateManifest({ ...manifest, models: [{ ...manifest.models[0], launchPath: '../outside.bin' }] }),
  { code: 'local_manifest_invalid' },
);
```

Also assert that a catalog not containing exactly both allowed model IDs, an unknown or duplicate ID, non-HTTPS URL, missing display/license/source metadata, or `launchPath` not equal to `.` or one of the declared file paths is rejected.

- [ ] **Step 2: Run the schema test and observe failure**

Run:

```powershell
node --test electron/captions/local-model-manifest.test.cjs
```

Expected: FAIL because the current validator does not constrain model IDs or presentation/launch metadata.

- [ ] **Step 3: Implement the expanded validator**

Add these invariants to `validateManifest`:

```js
const ALLOWED_MODEL_IDS = new Set(['whisper-small', 'hy-mt2-1.8b']);
const ALLOWED_DEVICES = new Set(['NPU', 'GPU', 'CPU']);

if (manifest.models.length !== ALLOWED_MODEL_IDS.size) {
  throw invalidManifest('The local model catalog must contain exactly Whisper and HY-MT2');
}
if (!ALLOWED_MODEL_IDS.has(model.id)) throw invalidManifest(`Unsupported local model: ${model.id}`);
if (
  !model.displayName || !model.purpose || !model.license || !model.source ||
  !ALLOWED_DEVICES.has(model.expectedDevice)
) {
  throw invalidManifest(`Local model metadata is incomplete for ${model.id}`);
}
if (!Number.isSafeInteger(model.unpackedSize) || model.unpackedSize < 0) {
  throw invalidManifest(`Invalid unpacked size for ${model.id}`);
}
if (
  model.launchPath !== '.' &&
  !model.files.some((file) => file.path === model.launchPath)
) {
  throw invalidManifest(`Invalid launch path for ${model.id}`);
}
```

Export `ALLOWED_MODEL_IDS` and `validateManifest` for contract tests.

- [ ] **Step 4: Write failing loader tests**

Create tests covering these exact outcomes:

```js
const unavailable = loadLocalModelCatalog({
  isPackaged: true,
  resourcesPath: missingRoot,
  appPath: missingRoot,
});
assert.equal(unavailable.available, false);
assert.equal(unavailable.error.code, 'local_catalog_unavailable');

const loaded = loadLocalModelCatalog({
  isPackaged: true,
  resourcesPath,
  appPath: repoRoot,
});
assert.equal(loaded.available, true);
assert.deepEqual(loaded.manifest.models.map((model) => model.id), [
  'whisper-small',
  'hy-mt2-1.8b',
]);
```

The packaged fixture must place `model-manifest.json`, `model-manifest.sig`, and `model-manifest-public.pem` under `<resourcesPath>/resources/local-models`, sign with an ephemeral Ed25519 private key, and fail closed when any byte or signature is changed.

- [ ] **Step 5: Run the loader test and observe failure**

Run:

```powershell
node --test electron/captions/local-model-manifest-loader.test.cjs
```

Expected: FAIL because `loadLocalModelCatalog` does not exist.

- [ ] **Step 6: Implement the catalog loader**

Use this contract:

```js
function catalogRoot({ isPackaged, resourcesPath, appPath }) {
  return isPackaged
    ? path.join(resourcesPath, 'resources', 'local-models')
    : path.join(appPath, 'resources', 'local-models');
}

function loadLocalModelCatalog(options) {
  const root = catalogRoot(options);
  try {
    const json = options.fsImpl.readFileSync(path.join(root, 'model-manifest.json'), 'utf8');
    const signature = options.fsImpl.readFileSync(path.join(root, 'model-manifest.sig'), 'utf8').trim();
    const publicKey = options.fsImpl.readFileSync(path.join(root, 'model-manifest-public.pem'), 'utf8');
    return {
      available: true,
      root,
      manifest: loadManifest({ json, signature, publicKey, packaged: options.isPackaged }),
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      root,
      manifest: null,
      error: {
        code: error.code || 'local_catalog_unavailable',
        message: 'Local model downloads are unavailable in this build.',
      },
    };
  }
}
```

Default `fsImpl` to `fs`; do not return the underlying path or signature to the renderer.

- [ ] **Step 7: Document the release artifact contract and commit**

`resources/local-models/README.md` must name the three expected files, state that manifests contain only app-controlled HTTPS URLs, and state that the private key must remain outside the repository/build worker.

Run:

```powershell
node --test electron/captions/local-model-manifest.test.cjs electron/captions/local-model-manifest-loader.test.cjs
git add electron/captions/local-model-manifest* resources/local-models/README.md
git commit -m "feat: load signed local model catalog"
```

Expected: all catalog tests pass and no private key, real model weight, or unsigned manifest is committed.

## Task 3: Make `LocalModelManager` production-safe and observable

**Files:**

- Modify: `electron/captions/local-model-manager.js`
- Modify: `electron/captions/local-model-manager.test.cjs`

- [ ] **Step 1: Add failing lifecycle and independence tests**

Build a two-model fixture and assert:

```js
assert.deepEqual(manager.status().models['whisper-small'].phase, 'not-installed');
assert.deepEqual(manager.status().models['hy-mt2-1.8b'].phase, 'not-installed');

await manager.download('whisper-small');
assert.equal(manager.status().models['whisper-small'].phase, 'ready');
assert.equal(manager.status().models['hy-mt2-1.8b'].phase, 'not-installed');

await manager.remove('whisper-small');
assert.equal(manager.status().models['whisper-small'].phase, 'not-installed');
```

Also assert that `status()` includes `displayName`, `purpose`, `expectedDevice`, `version`, `downloadBytes`, `installedBytes`, `downloadedBytes`, `repairRecommended`, and `error` for both model IDs.

- [ ] **Step 2: Add failing resume and bounded-stream tests**

Use a fake response body yielding three chunks and a pre-existing `.partial` file. Assert:

```js
assert.equal(requestHeaders.Range, 'bytes=4-');
assert.deepEqual(progress.map((event) => event.phase), [
  'downloading',
  'downloading',
  'verifying',
  'ready',
]);
assert.equal(maxChunkObserved <= 4, true);
```

Add a second test where the server answers `200` to a ranged request; the final file must equal the response bytes exactly, not partial bytes plus the full response.

- [ ] **Step 3: Add failing verify/repair/corruption tests**

Assert these operations:

```js
await manager.download('whisper-small');
await manager.verify('whisper-small');
assert.equal(manager.status().models['whisper-small'].phase, 'ready');

fs.writeFileSync(installedFile, 'corrupt');
await assert.rejects(manager.verify('whisper-small'), { code: 'local_model_hash_mismatch' });
assert.equal(manager.status().models['whisper-small'].phase, 'repair-needed');

await manager.repair('whisper-small');
assert.equal(manager.status().models['whisper-small'].phase, 'ready');
```

Also test same-model concurrent mutation, active-meeting `download`/`verify`/`repair`/`remove`, low disk/write failure preservation, and removal of only the selected version.

- [ ] **Step 4: Run the expanded manager suite and observe failures**

Run:

```powershell
node --test electron/captions/local-model-manager.test.cjs
```

Expected: FAIL on missing phases, streamed progress, `verify`, and `repair`.

- [ ] **Step 5: Implement streamed file transfer**

Replace `response.arrayBuffer()` with `Readable.fromWeb(response.body)` and `pipeline` into an append-or-write stream:

```js
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

async function streamResponse(response, destination, { append, onChunk }) {
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => onChunk(chunk.length));
  await pipeline(source, fs.createWriteStream(destination, {
    flags: append ? 'a' : 'w',
    mode: 0o600,
  }));
}
```

When a Range request receives anything other than `206`, truncate/restart the partial file before writing. Keep one active mutation per model in an `operations` `Map` so phase/progress can be returned by `status()`, plus a `failures` `Map` that retains the last row-specific error/`repair-needed` phase after an operation leaves `operations`. Clear `failures` only after successful verification or removal.

- [ ] **Step 6: Implement full verification and repair**

Use one verification path for download completion and the explicit Verify action:

```js
async verify(modelId) {
  this.assertMutable(modelId);
  const model = this.model(modelId);
  this.setOperation(modelId, { phase: 'verifying', downloadedBytes: modelDownloadBytes(model) });
  try {
    const files = {};
    for (const file of model.files) {
      const candidate = this.filePath(model, file.path);
      if ((await fsp.stat(candidate)).size !== file.size) throw modelError('local_model_size_mismatch', `Size mismatch for ${file.path}`);
      const digest = await sha256(candidate);
      if (digest !== file.sha256) throw modelError('local_model_hash_mismatch', `Hash mismatch for ${file.path}`);
      files[file.path] = digest;
    }
    await this.writeVerifiedMarker(model, files);
    this.publish(modelId, 'ready');
    return this.status().models[modelId];
  } catch (error) {
    await this.invalidateMarker(model);
    this.publish(modelId, 'repair-needed', error);
    throw error;
  }
}
```

`repair(modelId)` owns one mutation slot, deletes only corrupt declared files/partials, retains hash-valid files, then calls a private `downloadModelFiles(model)` helper and the private verification helper. It must not call public `download(modelId)` while already marked active. `status()` may trust a matching marker for fast startup, while explicit Verify always hashes bytes.

- [ ] **Step 7: Run manager tests and commit**

Run:

```powershell
node --test electron/captions/local-model-manager.test.cjs
git add electron/captions/local-model-manager.js electron/captions/local-model-manager.test.cjs
git commit -m "feat: manage observable local model lifecycle"
```

Expected: all manager tests pass without buffering an entire model in memory.

## Task 4: Compose installation and runtime readiness in one service

**Files:**

- Create: `electron/captions/local-model-service.js`
- Create: `electron/captions/local-model-service.test.cjs`
- Modify: `electron/captions/local-inference-paths.js`
- Modify: `electron/captions/local-inference-paths.test.cjs`
- Modify: `electron/captions/local-inference-supervisor.js`
- Modify: `electron/captions/local-inference-supervisor.test.cjs`
- Modify: `electron/captions/caption-session-manager.js`
- Modify: `electron/captions/caption-foundation.test.cjs`

- [ ] **Step 1: Write failing catalog-derived path tests**

Pass the loaded manifest into `resolveLocalInferencePaths` and assert:

```js
assert.match(paths.whisperModelPath, /local-models\\whisper-small\\973afd24965f72e36ca33b3055d56a652f456b4d$/);
assert.match(paths.hyMt2ModelPath, /local-models\\hy-mt2-1\.8b\\1cd5208700acedef4ef93019b6cfc148b8522d45\\Hy-MT2-1\.8B-Q4_K_M\.gguf$/);
```

Delete `WHISPER_VERSION`, `HYMT2_VERSION`, and `HYMT2_FILENAME` constants after the manifest owns these values.

When `manifest` is null, keep `runtimeRoot`, executable, llama binary, cache, and `modelRoot` defined, but return `whisperModelPath: null` and `hyMt2ModelPath: null`. This lets the packaged app report an unavailable catalog without inventing an install path/version.

- [ ] **Step 2: Write failing service composition tests**

Use fake manager/supervisor/session functions and assert:

```js
assert.deepEqual(service.status().models['whisper-small'], {
  ...managerStatus.models['whisper-small'],
  actualDevice: 'NPU',
});
assert.equal(service.status().runtimeReady, true);
assert.equal(service.status().actionsLocked, false);

await service.install('whisper-small');
assert.equal(events.at(-1).models['whisper-small'].phase, 'ready');
await service.remove('whisper-small');
assert.equal(events.at(-1).models['whisper-small'].phase, 'not-installed');
```

Test a missing catalog: both known rows exist with phase `unavailable`, `downloadsAvailable` is false, and operations throw `local_catalog_unavailable`.

- [ ] **Step 3: Write a failing supervisor single-source test**

Construct a supervisor where files and `.verified.json` exist but `modelReady('whisper-small')` returns false. Assert readiness remains false. Then return true and assert readiness becomes true:

```js
const supervisor = new LocalInferenceSupervisor({
  artifactReady: (kind) => kind === 'runtime',
  modelReady: (id) => id === 'whisper-small' && verified,
  whisperModelPath,
});
assert.equal(supervisor.readiness().models['whisper-small'].ready, false);
verified = true;
assert.equal(supervisor.readiness().models['whisper-small'].ready, true);
```

- [ ] **Step 4: Add and test `CaptionSessionManager.isActive()`**

Implement only:

```js
isActive() {
  return this.active;
}
```

Pin `false` before start, `true` while mock/live start is active, and `false` after stop in `caption-foundation.test.cjs`.

- [ ] **Step 5: Implement `LocalModelService`**

Use `EventEmitter` and this public contract:

```js
class LocalModelService extends EventEmitter {
  constructor({ catalog, manager, supervisor, sessionActive = () => false }) {
    super();
    this.catalog = catalog;
    this.manager = manager;
    this.supervisor = supervisor;
    this.sessionActive = sessionActive;
  }

  status() {
    const managed = this.manager?.status();
    const runtime = this.supervisor?.readiness() || {
      runtimeReady: false,
      requestedDevice: 'NPU',
      models: {},
    };
    const models = Object.fromEntries(
      ['whisper-small', 'hy-mt2-1.8b'].map((id) => {
        const declared = this.catalog.manifest?.models.find((model) => model.id === id);
        const installed = managed?.models[id];
        return [id, installed
          ? { ...installed, actualDevice: runtime.models[id]?.actualDevice || null }
          : {
              id,
              displayName: id === 'whisper-small' ? 'Whisper' : 'HY-MT2',
              purpose: id === 'whisper-small' ? 'Local transcription' : 'Local translation',
              version: declared?.version || null,
              expectedDevice: id === 'whisper-small' ? 'NPU' : 'CPU',
              actualDevice: null,
              phase: 'unavailable',
              ready: false,
              downloadBytes: null,
              installedBytes: 0,
              downloadedBytes: 0,
              repairRecommended: false,
              error: this.catalog.error,
            }];
      }),
    );
    return {
      downloadsAvailable: this.catalog.available,
      runtimeReady: runtime.runtimeReady,
      requestedDevice: runtime.requestedDevice,
      actionsLocked: this.sessionActive(),
      catalogError: this.catalog.error,
      models,
    };
  }

  modelReady(modelId) { return this.manager?.status().models[modelId]?.ready === true; }
  async install(modelId) { return this.run(modelId, () => this.manager.download(modelId)); }
  async verify(modelId) { return this.run(modelId, () => this.manager.verify(modelId)); }
  async repair(modelId) { return this.run(modelId, () => this.manager.repair(modelId)); }
  async remove(modelId) { return this.run(modelId, () => this.manager.remove(modelId)); }
  publish() { const snapshot = this.status(); this.emit('status', snapshot); return snapshot; }
}
```

`run` validates the model ID against `catalog.manifest.models`, rejects an unavailable catalog with `local_catalog_unavailable`, rejects active meetings with `meeting_active`, awaits the supplied operation, and calls `publish()` in `finally`. The runtime factory in Task 6 connects the manager progress callback to `publish()`. Do not include catalog paths, URLs, hashes, or signatures in `status()`.

- [ ] **Step 6: Make supervisor readiness delegate to `modelReady`**

Add a `modelReady` constructor dependency. For packaged models, use it instead of `hasVerifiedMarker`; retain `hasDevelopmentModel` only when no manager is configured in development smoke tools. Clear cached readiness after service mutation so Remove is immediately reflected.

- [ ] **Step 7: Run service/readiness/session tests and commit**

Run:

```powershell
node --test electron/captions/local-model-service.test.cjs electron/captions/local-inference-paths.test.cjs electron/captions/local-inference-supervisor.test.cjs electron/captions/caption-foundation.test.cjs
git add electron/captions/local-model-service* electron/captions/local-inference-paths* electron/captions/local-inference-supervisor* electron/captions/caption-session-manager.js electron/captions/caption-foundation.test.cjs
git commit -m "feat: unify local model and runtime readiness"
```

Expected: installed state, runtime state, and meeting locks come from one service snapshot.

## Task 5: Expose narrow, validated IPC

**Files:**

- Create: `electron/captions/local-model-ipc.test.cjs`
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-preload.js`
- Modify: `src/captions/types.ts`
- Modify: `src/electron.d.ts`

- [ ] **Step 1: Define renderer types before IPC use**

Add:

```ts
export type LocalModelId = 'whisper-small' | 'hy-mt2-1.8b';
export type LocalModelPhase =
  | 'checking'
  | 'unavailable'
  | 'not-installed'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'repair-needed'
  | 'failed';

export interface LocalModelState {
  id: LocalModelId;
  displayName: string;
  purpose: string;
  version: string | null;
  expectedDevice: 'NPU' | 'GPU' | 'CPU';
  actualDevice: string | null;
  phase: LocalModelPhase;
  ready: boolean;
  downloadBytes: number | null;
  installedBytes: number;
  downloadedBytes: number;
  repairRecommended: boolean;
  error: { code: string; message: string } | null;
}

export interface LocalModelStatus {
  downloadsAvailable: boolean;
  runtimeReady: boolean;
  requestedDevice: 'NPU' | 'GPU' | 'CPU';
  actionsLocked: boolean;
  catalogError: { code: string; message: string } | null;
  models: Record<LocalModelId, LocalModelState>;
}
```

Replace the renderer's use of `LocalInferenceStatus` with `LocalModelStatus`; retain the old interface only if a main-process-only compatibility test still consumes it.

- [ ] **Step 2: Write failing IPC tests**

Capture registered handlers and assert these channels:

```js
await handlers.get('captions:local-model-status')(trustedEvent);
await handlers.get('captions:local-model-install')(trustedEvent, { modelId: 'whisper-small' });
await handlers.get('captions:local-model-verify')(trustedEvent, { modelId: 'hy-mt2-1.8b' });
await handlers.get('captions:local-model-remove')(trustedEvent, { modelId: 'whisper-small' });
```

Assert unknown IDs are rejected, untrusted senders are rejected, the remove service method runs only after the confirmation's destructive button is selected, and each successful operation broadcasts `captions:local-model-status`.

- [ ] **Step 3: Run the IPC test and observe failure**

Run:

```powershell
node --test electron/captions/local-model-ipc.test.cjs
```

Expected: FAIL because the channels and `localModelService` dependency do not exist.

- [ ] **Step 4: Register model IPC handlers**

Extend `registerCaptionIpc` with `localModelService = null` and add:

```js
handle('captions:local-model-status', () => localModelService.status());
handle('captions:local-model-install', async ({ modelId }) => {
  await localModelService.install(modelId);
  return localModelService.status();
});
handle('captions:local-model-verify', async ({ modelId }) => {
  await localModelService.verify(modelId);
  return localModelService.status();
});
handle('captions:local-model-repair', async ({ modelId }) => {
  await localModelService.repair(modelId);
  return localModelService.status();
});
handle('captions:local-model-remove', async ({ modelId }) => {
  const model = localModelService.status().models[modelId];
  if (!model) throw Object.assign(new Error('Unknown local model'), { code: 'local_model_unknown' });
  const confirmation = await dialog.showMessageBox(windows.controlWindow, {
    type: 'warning',
    title: `Remove ${model.displayName}?`,
    message: `Remove ${model.displayName}?`,
    detail: 'The model must be downloaded again before this local option can start a meeting.',
    buttons: ['Cancel', 'Remove model'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (confirmation.response !== 1) return { canceled: true, status: localModelService.status() };
  await localModelService.remove(modelId);
  return { canceled: false, status: localModelService.status() };
});
```

Subscribe once for the app lifetime during registration:

```js
localModelService.on('status', (status) => {
  windows.broadcastControl('captions:local-model-status', status);
});
```

- [ ] **Step 5: Expose preload methods and event subscription**

Add `'captions:local-model-status'` to `EVENT_CHANNELS` and expose:

```js
getLocalModelStatus: () => invoke('captions:local-model-status'),
installLocalModel: (modelId) => invoke('captions:local-model-install', { modelId }),
verifyLocalModel: (modelId) => invoke('captions:local-model-verify', { modelId }),
repairLocalModel: (modelId) => invoke('captions:local-model-repair', { modelId }),
removeLocalModel: (modelId) => invoke('captions:local-model-remove', { modelId }),
onLocalModelStatus: (callback) => subscribe('captions:local-model-status', callback),
```

Mirror these exact names in `src/electron.d.ts`, returning `Result<LocalModelStatus>` and an unsubscribe function for the event.

- [ ] **Step 6: Run IPC and type/build checks, then commit**

Run:

```powershell
node --test electron/captions/local-model-ipc.test.cjs electron/captions/native-camera-ipc.test.cjs
npm run build
git add electron/captions/local-model-ipc.test.cjs electron/captions/register-caption-ipc.js electron/captions-preload.js src/captions/types.ts src/electron.d.ts
git commit -m "feat: expose local model lifecycle to settings"
```

Expected: IPC tests and TypeScript production build pass.

## Task 6: Wire catalog, manager, supervisor, and session lifecycle in main

**Files:**

- Create: `electron/captions/local-model-runtime.js`
- Create: `electron/captions/local-model-runtime.test.cjs`
- Modify: `electron/captions-main.js`

- [ ] **Step 1: Add a failing runtime composition test**

Create `local-model-runtime.test.cjs` with injected catalog loader, manager, and supervisor factories:

```js
const runtime = createLocalModelRuntime({
  isPackaged: true,
  resourcesPath: 'C:\\Program Files\\Twinscript\\resources',
  appPath: 'C:\\Program Files\\Twinscript\\resources\\app.asar',
  userDataPath: 'C:\\Users\\test\\AppData\\Roaming\\Twinscript',
  sessionActive: () => meetingActive,
  loadCatalog: () => catalog,
  createManager: (options) => new FakeManager(options),
  createSupervisor: (options) => new FakeSupervisor(options),
});

runtime.service.on('status', (status) => statusEvents.push(status));
assert.equal(runtime.service.status().downloadsAvailable, true);
assert.equal(runtime.service.status().actionsLocked, false);
meetingActive = true;
assert.equal(runtime.service.status().actionsLocked, true);
assert.equal(
  runtime.supervisor.options.modelReady('whisper-small'),
  runtime.service.modelReady('whisper-small'),
);
runtime.manager.options.onProgress();
assert.equal(statusEvents.length, 1);
```

Add a second construction whose loader returns `{ available: false, manifest: null, error: { code: 'local_catalog_unavailable', message: 'Local model downloads are unavailable in this build.' } }`. Assert `manager` is null, both rows are `unavailable`, and construction performs no network request.

- [ ] **Step 2: Run the runtime test and observe failure**

Run:

```powershell
node --test electron/captions/local-model-runtime.test.cjs
```

Expected: FAIL because `createLocalModelRuntime` does not exist.

- [ ] **Step 3: Implement the runtime composition root**

Create `createLocalModelRuntime` with injectable defaults and this dependency order:

```js
function createLocalModelRuntime({
  isPackaged,
  resourcesPath,
  appPath,
  userDataPath,
  sessionActive,
  loadCatalog = loadLocalModelCatalog,
  createManager = (options) => new LocalModelManager(options),
  createSupervisor = (options) => new LocalInferenceSupervisor(options),
}) {
  const catalog = loadCatalog({ isPackaged, resourcesPath, appPath });
  const paths = resolveLocalInferencePaths({
    isPackaged,
    resourcesPath,
    appPath,
    userDataPath,
    manifest: catalog.manifest,
  });
  let service = null;
  const manager = catalog.available
    ? createManager({
        manifest: catalog.manifest,
        root: paths.modelRoot,
        sessionActive,
        onProgress: () => service?.publish(),
      })
    : null;
  const supervisor = createSupervisor({
    isPackaged,
    resourcesPath,
    appPath,
    ...paths,
    whisperDevice: 'NPU',
    modelReady: (modelId) => service?.modelReady(modelId) || false,
  });
  service = new LocalModelService({ catalog, manager, supervisor, sessionActive });
  return { catalog, paths, manager, supervisor, service };
}
```

Export only `createLocalModelRuntime`. The closure deliberately declares `service` before manager/supervisor construction; progress and readiness callbacks run only after construction.

- [ ] **Step 4: Use the composition root from `captions-main.js`**

Declare `let sessionManager = null`, then construct:

```js
const localModels = createLocalModelRuntime({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  userDataPath: app.getPath('userData'),
  sessionActive: () => sessionManager?.isActive() || false,
});
localInferenceSupervisor = localModels.supervisor;
localModelService = localModels.service;
```

Construct `CaptionSessionManager` afterward. Pass `localInferenceSupervisor` into the session manager and `localModelService` into `registerCaptionIpc`.

- [ ] **Step 5: Broadcast the initial status after the control window exists**

After IPC registration and window creation, call:

```js
captionWindows.broadcastControl(
  'captions:local-model-status',
  localModelService.status(),
);
```

On shutdown, remove service listeners after `localInferenceSupervisor.dispose()`; do not delete partial downloads or installed models.

- [ ] **Step 6: Run runtime/main regression tests and commit**

Run:

```powershell
node --test electron/captions/local-model-runtime.test.cjs
npm run test:captions
npm run build
git add electron/captions/local-model-runtime.js electron/captions/local-model-runtime.test.cjs electron/captions-main.js
git commit -m "feat: activate local model installation service"
```

Expected: all caption/main/native tests and production build pass with no network request at startup.

## Task 7: Build the dedicated Local AI Models card

**Files:**

- Create: `src/captions/LocalModelInstallCard.tsx`
- Create: `src/captions/LocalModelInstallCard.test.tsx`
- Modify: `src/captions/captions.css`

- [ ] **Step 1: Write failing not-installed and independent-row tests**

Render a full two-model status and assert:

```tsx
expect(screen.getByRole('heading', { name: 'Private, on-device processing' })).toBeInTheDocument();
expect(screen.getByRole('button', { name: 'Install Whisper local transcription model' })).toBeEnabled();
expect(screen.getByRole('button', { name: 'Install HY-MT2 local translation model' })).toBeEnabled();

await user.click(screen.getByRole('button', { name: 'Install Whisper local transcription model' }));
expect(onAction).toHaveBeenCalledWith('install', 'whisper-small');
expect(onAction).not.toHaveBeenCalledWith('install', 'hy-mt2-1.8b');
```

- [ ] **Step 2: Write failing state, accessibility, and lock tests**

Cover:

```tsx
expect(screen.getByRole('progressbar', { name: 'Downloading Whisper' })).toHaveAttribute('aria-valuenow', '50');
expect(screen.getByText('Verifying downloaded files')).toBeInTheDocument();
expect(screen.getByRole('button', { name: 'Verify Whisper local transcription model' })).toBeEnabled();
expect(screen.getByRole('button', { name: 'Repair HY-MT2 local translation model' })).toBeEnabled();
expect(screen.getByRole('alert')).toHaveTextContent('Hash mismatch');
expect(screen.getByRole('button', { name: /Remove HY-MT2/ })).toBeDisabled();
expect(screen.getByText(/Finish the active meeting/)).toBeInTheDocument();
```

Also assert the unavailable-catalog state renders **Downloads unavailable in this build** and no enabled Install action.

- [ ] **Step 3: Run the component test and observe failure**

Run:

```powershell
npx vitest run src/captions/LocalModelInstallCard.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 4: Implement the presentational component**

Use this prop boundary:

```tsx
interface Props {
  status: LocalModelStatus | null;
  busyModel: LocalModelId | null;
  rowRefs?: Partial<Record<LocalModelId, React.RefObject<HTMLElement | null>>>;
  onAction(action: 'install' | 'verify' | 'repair' | 'remove', modelId: LocalModelId): void;
}
```

Render one `<article className="card local-model-card">`, an aggregate badge, and two `<section className="local-model-row">` elements. Compute actions solely from `phase`; do not infer state from button text. Format bytes with one shared `formatBytes` helper and use native `<progress>` with `max` and `value` during download.

For ready Whisper show **Designed for Intel NPU** before any session evidence and **Last ran on NPU/GPU/CPU** when `actualDevice` exists. For HY-MT2 show **Runs locally on CPU** until runtime evidence reports something else.

- [ ] **Step 5: Add card styling**

Add scoped classes for `.local-model-card`, `.local-model-row`, `.local-model-state`, `.local-model-progress`, and `.local-model-actions`. Preserve existing design tokens. Required behavior:

```css
.local-model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-4);
  min-height: 44px;
}

@media (max-width: 640px) {
  .local-model-row { grid-template-columns: 1fr; }
  .local-model-actions .button { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .local-model-card progress { transition: none; }
}
```

Use text plus icon for every state, visible `:focus-visible`, and no alert role for normal Not installed.

- [ ] **Step 6: Run component tests and commit**

Run:

```powershell
npx vitest run src/captions/LocalModelInstallCard.test.tsx
git add src/captions/LocalModelInstallCard.tsx src/captions/LocalModelInstallCard.test.tsx src/captions/captions.css
git commit -m "feat: add local AI model installation card"
```

Expected: card states/actions pass independently of `ControlApp`.

## Task 8: Integrate the card with Settings and pipeline recovery

**Files:**

- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/ControlApp.test.tsx`

- [ ] **Step 1: Extend the renderer API mock**

Add default mocks and a captured listener:

```ts
getLocalModelStatus: vi.fn().mockResolvedValue({ ok: true, data: notInstalledStatus }),
installLocalModel: vi.fn(),
verifyLocalModel: vi.fn(),
repairLocalModel: vi.fn(),
removeLocalModel: vi.fn(),
onLocalModelStatus: vi.fn((callback) => {
  localModelStatusListener = callback;
  return () => { localModelStatusListener = undefined; };
}),
```

- [ ] **Step 2: Write failing integration tests**

Assert:

```tsx
expect(await screen.findByText('Private, on-device processing')).toBeInTheDocument();
await user.click(screen.getByRole('button', { name: 'Install Whisper local transcription model' }));
expect(window.captions.installLocalModel).toHaveBeenCalledWith('whisper-small');

act(() => localModelStatusListener?.(whisperReadyStatus));
expect(screen.getByText('Whisper ready')).toBeInTheDocument();
expect(screen.getByText('HY-MT2 not installed')).toBeInTheDocument();
```

Add tests that a pipeline warning button scrolls/focuses the corresponding row, meeting-active snapshots disable all mutations, a failed action remains row-specific, successful Remove leaves the pipeline selection unchanged, and unmount invokes the subscription cleanup.

- [ ] **Step 3: Run ControlApp tests and observe failure**

Run:

```powershell
npx vitest run src/captions/ControlApp.test.tsx
```

Expected: FAIL because `ControlApp` still calls `getLocalInferenceStatus` and has no install card/actions.

- [ ] **Step 4: Load and subscribe to model status**

Replace `localInference` state with:

```tsx
const [localModels, setLocalModels] = useState<LocalModelStatus | null>(null);
const [busyModel, setBusyModel] = useState<LocalModelId | null>(null);
const localModelRows = {
  'whisper-small': useRef<HTMLElement>(null),
  'hy-mt2-1.8b': useRef<HTMLElement>(null),
};
```

Initial load uses `getLocalModelStatus()`. In the existing effect, subscribe with `onLocalModelStatus(setLocalModels)` and call the returned cleanup on unmount.

- [ ] **Step 5: Implement one bounded action runner**

```tsx
const runLocalModelAction = async (
  action: 'install' | 'verify' | 'repair' | 'remove',
  modelId: LocalModelId,
) => {
  setBusyModel(modelId);
  setError(null);
  try {
    const api = {
      install: window.captions.installLocalModel,
      verify: window.captions.verifyLocalModel,
      repair: window.captions.repairLocalModel,
      remove: window.captions.removeLocalModel,
    }[action];
    const result = await api(modelId);
    if (!result.ok) throw new Error(result.error.message);
    const status = 'status' in result.data ? result.data.status : result.data;
    setLocalModels(status);
  } catch (error) {
    setError(error instanceof Error ? error.message : 'Local model action failed');
  } finally {
    setBusyModel(null);
  }
};
```

Do not clear the service-published row error with a generic renderer error; associate generic IPC failures with the selected row or existing Settings error surface.

- [ ] **Step 6: Insert the card and recovery links**

Render `<LocalModelInstallCard>` immediately after Meeting Pipeline. Keep readiness chips in Meeting Pipeline, but render a keyboard-operable **Manage Whisper** or **Manage HY-MT2** recovery button when the selected requirement is unavailable:

```tsx
const focusLocalModel = (modelId: LocalModelId) => {
  localModelRows[modelId].current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  localModelRows[modelId].current?.focus({ preventScroll: true });
};
```

Use `behavior: 'auto'` when `prefers-reduced-motion: reduce` matches. Each row needs `tabIndex={-1}` so programmatic focus is visible.

- [ ] **Step 7: Run renderer tests and commit**

Run:

```powershell
npx vitest run src/captions/ControlApp.test.tsx src/captions/LocalModelInstallCard.test.tsx
npm run build
git add src/captions/ControlApp.tsx src/captions/ControlApp.test.tsx
git commit -m "feat: connect model installation to meeting settings"
```

Expected: the card is always visible, rows remain independent, and the pipeline points to exact recovery.

## Task 9: Add offline signing tooling and packaging guards

**Files:**

- Create: `scripts/release/sign-local-model-manifest.cjs`
- Create: `scripts/release/local-model-manifest.test.cjs`
- Modify: `forge.config.js`

- [ ] **Step 1: Write failing signing-tool tests**

Generate an ephemeral Ed25519 key pair and assert:

```js
const signature = signManifest({ manifestPath, privateKeyPath, outputPath });
const verified = crypto.verify(
  null,
  Buffer.from(canonicalJson(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))),
  publicKey,
  Buffer.from(signature, 'base64'),
);
assert.equal(verified, true);
assert.equal(fs.readFileSync(outputPath, 'utf8').trim(), signature);
```

Also reject a non-Ed25519 key, invalid manifest schema, missing input, or output path equal to the private-key path.

- [ ] **Step 2: Run the release test and observe failure**

Run:

```powershell
node --test scripts/release/local-model-manifest.test.cjs
```

Expected: FAIL because the signing tool does not exist.

- [ ] **Step 3: Implement the offline signing tool**

Export `signManifest` for tests and support this CLI only:

```powershell
node scripts/release/sign-local-model-manifest.cjs <manifest.json> <ed25519-private.pem> <manifest.sig>
```

Implementation must call `validateManifest`, sign `canonicalJson(manifest)`, write only the base64 signature with mode `0o600`, and never log the private key or manifest contents.

- [ ] **Step 4: Add a packaging contract guard**

Because `forge.config.js` already copies `resources`, add a testable assertion/helper that `resources/local-models` maps to `<process.resourcesPath>/resources/local-models`. Packaging is allowed when the directory contains only `README.md`; the application then shows **Downloads unavailable in this build**. When release artifacts are present, all three required files must be packaged together or the loader returns unavailable.

Do not commit `model-manifest.json`, `model-manifest.sig`, `model-manifest-public.pem`, a private key, or model weights in this implementation commit.

- [ ] **Step 5: Run release/packaging tests and commit**

Run:

```powershell
node --test scripts/release/local-model-manifest.test.cjs electron/captions/local-model-manifest-loader.test.cjs
npm run build
git add scripts/release/sign-local-model-manifest.cjs scripts/release/local-model-manifest.test.cjs forge.config.js
git commit -m "build: add signed model catalog release tooling"
```

Expected: signing and resource-path contracts pass without a repository private key.

## Task 10: Run the complete installation and caption verification gates

**Files:**

- Modify only if a failing test reveals a defect in files already listed above.

- [ ] **Step 1: Run all main/native caption tests**

Run:

```powershell
npm run test:captions
```

Expected: every Electron caption, native local-inference protocol, and release `.test.cjs` suite passes.

- [ ] **Step 2: Run all renderer and audio-capture tests**

Run:

```powershell
npm test -- --run
```

Expected: all caption UI and modern-audio suites pass, including the restored 48-to-24 kHz fallback regression.

- [ ] **Step 3: Run the native host tests**

Run, using the existing configured build directory:

```powershell
ctest --test-dir artifacts/local-inference-host/build --output-on-failure
```

Expected: protocol, segmentation, transport, cancellation, and Whisper engine tests pass. If the build directory is absent, first run `powershell -ExecutionPolicy Bypass -File scripts/build-local-inference-host.ps1`, then rerun `ctest`.

- [ ] **Step 4: Run production build and packaged smoke**

Run:

```powershell
npm run build
npm run package
npm run smoke:packaged
```

Expected: production renderer/main build succeeds; package contains the runtime and catalog README but no model weights; packaged launch/close succeeds; Local AI Models shows **Downloads unavailable in this build** until signed release files are supplied.

- [ ] **Step 5: Run a local HTTP fixture end-to-end installation smoke**

Use the test fixture catalog signed with an ephemeral key and two small model files served by the existing Node test HTTP server. Verify, through the service/IPC boundary:

1. install Whisper while HY-MT2 stays Not installed;
2. restart the service and retain Whisper Ready;
3. corrupt Whisper and observe Repair needed;
4. repair Whisper and return to Ready;
5. install HY-MT2 independently;
6. simulate an active meeting and observe all mutation actions locked;
7. remove Whisper and keep HY-MT2 Ready; and
8. confirm no OpenAI client, WebSocket, credential read, or content telemetry was invoked.

Run the resulting smoke test with:

```powershell
node --test electron/captions/local-model-service.test.cjs electron/captions/local-privacy.test.cjs
```

Expected: all eight outcomes pass.

- [ ] **Step 6: Inspect the final branch and commit only necessary fixes**

Run:

```powershell
git diff --check
git status --short
git log --oneline --left-right --cherry-pick HEAD...main
```

Expected: no whitespace errors, no unintended files, and no commit remaining only on `main`. If verification required a code correction, rerun the affected targeted test plus Steps 1–4, then commit with a message naming the corrected behavior.

## External production-release gate

The implementation can be completed and tested with signed local fixtures, but end-user model downloads remain deliberately disabled until release engineering provides all of the following together:

1. the exact validated OpenVINO Whisper directory and HY-MT2 GGUF at an app-controlled HTTPS origin;
2. a final manifest containing the actual URLs, sizes, hashes, license metadata, versions, and launch paths;
3. an Ed25519 signature created with the offline release private key; and
4. the matching public key packaged with the application.

Once those files are supplied, repeat Task 10 Steps 1–5 on a clean installed Windows account with the full-size artifacts. No code path may substitute direct upstream URLs or unsigned metadata when this gate is incomplete.
