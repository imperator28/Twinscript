# Hybrid and Full-Local Application Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently selectable cloud/local transcription and final-translation engines plus optional Hy-MT2 preview acceleration, while keeping the current OpenAI-plus-Luna experience as the default main track.

**Architecture:** The Electron caption process resolves an immutable processing configuration at meeting start, selects dependency-injected transcription and translation backends, and supervises the standalone native host. Existing audio capture continues to send the same 24 kHz PCM contract; no capture implementation is rewritten. A translation policy separates provisional acceleration from the authoritative final backend, and full-local startup is structurally unable to read credentials or construct cloud clients.

**Tech Stack:** Electron 40, Node.js CommonJS, React 19, TypeScript, Vitest, Node test runner, native host protocol v1, OpenVINO host artifact

---

**Depends on:** A verified Release host from `docs/superpowers/plans/2026-08-10-local-inference-host.md`.

**Shared-worktree caution:** `src/captions/audioCapture.ts`, `src/lib/modern-audio/BaseAudioRecorder.ts`, `src/lib/modern-audio/worklets/`, `src/lib/modern-audio/captureTransport.test.ts`, and `vitest.config.ts` contained unrelated changes when this plan was written. Do not overwrite, revert, or include them in feature commits. The integration consumes the existing `window.captions.sendAudio(channel, Int16Array)` contract.

### Task 1: Add validated processing settings without changing defaults

**Files:**
- Create: `electron/captions/processing-configuration.js`
- Create: `electron/captions/processing-configuration.test.cjs`
- Modify: `electron/captions/settings-store.js`
- Modify: `electron/captions/caption-foundation.test.cjs`
- Modify: `src/captions/types.ts`
- Modify: `src/captions/ControlApp.tsx`

- [ ] **Step 1: Write failing migration and configuration tests**

```javascript
test('v13 settings migrate to the unchanged cloud main track', () => {
  const store = settingsStoreFrom({ settingsVersion: 13, provisionalTranslation: true });
  const settings = store.get();
  assert.equal(settings.settingsVersion, 14);
  assert.equal(settings.transcriptionModel, 'openai-live');
  assert.equal(settings.finalTranslationModel, 'luna');
  assert.equal(settings.localTranslationAcceleration, false);
  assert.equal(settings.provisionalTranslation, true);
});

test('processing configuration derives cloud requirements and preview backend', () => {
  assert.deepEqual(resolveProcessingConfiguration({
    transcriptionModel: 'whisper-local',
    finalTranslationModel: 'luna',
    provisionalTranslation: true,
    localTranslationAcceleration: true,
  }), {
    transcription: 'whisper-local',
    finalTranslation: 'luna',
    provisionalTranslation: 'hy-mt2-local',
    requiresCredential: true,
    fullyLocal: false,
  });
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test electron/captions/processing-configuration.test.cjs`

Expected: FAIL because the module and settings do not exist.

- [ ] **Step 3: Implement strict enums and policy derivation**

```javascript
const TRANSCRIPTION_MODELS = new Set(['openai-live', 'whisper-local']);
const TRANSLATION_MODELS = new Set(['luna', 'hy-mt2-local']);

function resolveProcessingConfiguration(settings) {
  const transcription = TRANSCRIPTION_MODELS.has(settings.transcriptionModel)
    ? settings.transcriptionModel : 'openai-live';
  const finalTranslation = TRANSLATION_MODELS.has(settings.finalTranslationModel)
    ? settings.finalTranslationModel : 'luna';
  const provisionalTranslation = !settings.provisionalTranslation
    ? null
    : settings.localTranslationAcceleration
      ? 'hy-mt2-local'
      : finalTranslation;
  return {
    transcription,
    finalTranslation,
    provisionalTranslation,
    requiresCredential: transcription === 'openai-live' || finalTranslation === 'luna',
    fullyLocal: transcription === 'whisper-local' && finalTranslation === 'hy-mt2-local',
  };
}
```

Bump `settingsVersion` to 14 and add defaults `transcriptionModel: 'openai-live'`, `finalTranslationModel: 'luna'`, and `localTranslationAcceleration: false`. Normalize unknown values on every read and set. Do not change `provisionalTranslation` or the live-transcribe/Luna profile defaults.

Add the three properties to both `CaptionSettings` and renderer `DEFAULT_SETTINGS`.

- [ ] **Step 4: Run focused and foundation tests**

Run: `node --test electron/captions/processing-configuration.test.cjs electron/captions/caption-foundation.test.cjs`

Expected: PASS; existing main-track tests retain `provisionalTranslation: true`.

- [ ] **Step 5: Commit**

```powershell
git add electron/captions/processing-configuration.js electron/captions/processing-configuration.test.cjs electron/captions/settings-store.js electron/captions/caption-foundation.test.cjs src/captions/types.ts src/captions/ControlApp.tsx
git commit -m "feat: add composable processing settings"
```

### Task 2: Implement the main-process local host client and supervisor

**Files:**
- Create: `electron/captions/local-inference-client.js`
- Create: `electron/captions/local-inference-client.test.cjs`
- Create: `electron/captions/local-inference-supervisor.js`
- Create: `electron/captions/local-inference-supervisor.test.cjs`
- Modify: `electron/captions-main.js`

- [ ] **Step 1: Test handshake, correlation, bounds, and stale generations**

```javascript
test('client resolves only a correlated protocol-v1 reply', async () => {
  const transport = fakeTransport();
  const client = new LocalInferenceClient({ transport, timeoutMs: 100 });
  const pending = client.request('health', { sessionId: 's1' });
  const sent = JSON.parse(transport.writes[0]);
  transport.emit({ ...sent, type: 'health', generation: 1, queueDepth: 0 });
  assert.equal((await pending).queueDepth, 0);
});

test('supervisor discards replies from a replaced host generation', () => {
  const supervisor = new LocalInferenceSupervisor({ spawn: fakeSpawner() });
  supervisor.accept({ generation: 1, type: 'asr.result' });
  supervisor.restart();
  assert.equal(supervisor.accept({ generation: 1, type: 'asr.result' }), false);
});
```

- [ ] **Step 2: Verify focused tests fail**

Run: `node --test electron/captions/local-inference-client.test.cjs electron/captions/local-inference-supervisor.test.cjs`

Expected: FAIL importing the new modules.

- [ ] **Step 3: Implement the bounded client**

`LocalInferenceClient` writes compact JSON lines, caps outgoing lines at 1 MiB, correlates by request ID, times out preparation after 120 seconds and ordinary requests after 30 seconds, supports `AbortSignal` by sending `request.cancel`, and rejects every pending request when the transport closes. It validates `protocolVersion === 1`, session ID, host generation, and result type before resolving.

- [ ] **Step 4: Implement the supervised process**

`LocalInferenceSupervisor` resolves the executable from packaged `process.resourcesPath/local-inference-host` or development `artifacts/local-inference-host`, spawns with `windowsHide: true`, pipes only stdin/stdout/stderr, performs hello before exposing readiness, permits one in-session restart, and sends shutdown with a bounded wait before killing a hung child. It exposes `probe()`, `prepare(models)`, `client()`, `restart()`, and `dispose()`.

Construct one supervisor in `captions-main.js`, inject it into the session manager and IPC registration, and dispose it in the existing `before-quit` shutdown promise.

- [ ] **Step 5: Run tests and commit**

Run: `node --test electron/captions/local-inference-client.test.cjs electron/captions/local-inference-supervisor.test.cjs`

Expected: PASS.

```powershell
git add electron/captions/local-inference-client.js electron/captions/local-inference-client.test.cjs electron/captions/local-inference-supervisor.js electron/captions/local-inference-supervisor.test.cjs electron/captions-main.js
git commit -m "feat: supervise the local inference host"
```

### Task 3: Add signed model readiness and explicit downloads

**Files:**
- Create: `electron/captions/local-model-manifest.js`
- Create: `electron/captions/local-model-manifest.test.cjs`
- Create: `electron/captions/local-model-manager.js`
- Create: `electron/captions/local-model-manager.test.cjs`
- Create: `scripts/build-local-model-manifest.mjs`
- Create: `resources/local-models/README.md`
- Modify: `.gitignore`
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-preload.js`
- Modify: `src/electron.d.ts`

- [ ] **Step 1: Write failing signature, hash, resume, and active-session tests**

```javascript
test('packaged manifests require a valid Ed25519 signature', () => {
  assert.throws(() => loadManifest({ json, signature: badSignature, publicKey, packaged: true }), {
    code: 'local_manifest_invalid',
  });
});

test('download refuses to start during an active meeting', async () => {
  const manager = modelManager({ sessionActive: () => true });
  await assert.rejects(manager.download('whisper-small'), { code: 'meeting_active' });
});
```

- [ ] **Step 2: Implement manifest verification and model storage**

Use Node `crypto.verify(null, canonicalJsonBytes, publicKey, signature)` for Ed25519. The manifest contains `schemaVersion`, runtime compatibility, model ID/version/license/source, files with URL/size/SHA-256, and unpacked size. Development may accept a generated unsigned manifest only when `app.isPackaged === false`; packaged builds fail closed.

`LocalModelManager` stores files under `app.getPath('userData')/local-models/<id>/<version>`, downloads to `.partial`, resumes with HTTP range only when the server confirms it, verifies size and SHA-256, atomically renames verified files, and removes models only while no session is active. No download begins from session start.

- [ ] **Step 3: Add model-management IPC**

Register `captions:local-inference-status`, `captions:local-model-download`, and `captions:local-model-remove`. Broadcast `captions:local-inference-status` progress only to the control window. Add preload methods and `LocalInferenceStatus` types without exposing arbitrary URLs or paths to the renderer.

- [ ] **Step 4: Generate the release manifest from feasibility hashes**

`build-local-model-manifest.mjs` reads the resolved revisions and hashes from the feasibility artifacts, canonicalizes JSON, signs it with an Ed25519 private key supplied by `TWINSCRIPT_MODEL_SIGNING_KEY`, derives the matching public key, and writes manifest, base64 signature, and `public-key.pem` under ignored `artifacts/local-models/`. It never writes the private key. `resources/local-models/README.md` documents this release input and the development unsigned-manifest rule; no private or release public key is committed.

Add `/artifacts/local-models/` to `.gitignore`.

Run: `node --test electron/captions/local-model-manifest.test.cjs electron/captions/local-model-manager.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .gitignore electron/captions/local-model-manifest.js electron/captions/local-model-manifest.test.cjs electron/captions/local-model-manager.js electron/captions/local-model-manager.test.cjs electron/captions/register-caption-ipc.js electron/captions-preload.js src/electron.d.ts scripts/build-local-model-manifest.mjs resources/local-models/README.md
git commit -m "feat: manage verified local inference models"
```

### Task 4: Add cloud and local backend adapters

**Files:**
- Create: `electron/captions/transcription-backends.js`
- Create: `electron/captions/transcription-backends.test.cjs`
- Create: `electron/captions/translation-backends.js`
- Create: `electron/captions/translation-backends.test.cjs`

- [ ] **Step 1: Test adapters against one normalized contract**

```javascript
test('local Whisper maps protocol output to the existing transcript event', () => {
  const events = [];
  const backend = new LocalWhisperBackend({ client: fakeClient(), channel: 'microphone', onEvent: e => events.push(e) });
  backend.accept({ type: 'asr.result', channel: 'microphone', utteranceId: 'u1', text: 'Hello', final: true, actualDevice: 'NPU' });
  assert.deepEqual(events[0], {
    type: 'transcript', channel: 'microphone', itemId: 'u1', transcript: 'Hello', final: true,
    runtime: 'openvino-genai', model: 'whisper-small', actualDevice: 'NPU',
  });
});

test('Hy-MT2 conforms to the normalizer result shape', async () => {
  const result = await new LocalHyMt2Backend({ client: fakeClient('已确认') }).normalize({ sourceText: 'Confirmed', target: 'zh', final: true });
  assert.equal(result.text, '已确认');
  assert.equal(result.model, 'hy-mt2-1.8b');
  assert.equal(result.usage.inputTokens >= 0, true);
});
```

- [ ] **Step 2: Implement factories without rewriting cloud classes**

`TranscriptionBackendFactory.create('openai-live', options)` returns the existing `LiveTranscriptionSession`; `whisper-local` returns `LocalWhisperBackend`. `TranslationBackendFactory.create('luna', options)` returns the existing `OpenAINormalizer`; `hy-mt2-local` returns `LocalHyMt2Backend`.

Local ASR forwards the existing 24 kHz `Int16Array` as bounded base64 protocol audio and supports `connect`, `appendAudio`, `finish`, and `close`, matching the session manager's current transport lifecycle. Local translation maps `AbortSignal` to protocol cancellation and never fabricates OpenAI token cost.

- [ ] **Step 3: Run tests**

Run: `node --test electron/captions/transcription-backends.test.cjs electron/captions/translation-backends.test.cjs`

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add electron/captions/transcription-backends.js electron/captions/transcription-backends.test.cjs electron/captions/translation-backends.js electron/captions/translation-backends.test.cjs
git commit -m "feat: adapt cloud and local caption backends"
```

### Task 5: Separate provisional acceleration from final authority

**Files:**
- Create: `electron/captions/translation-policy.js`
- Create: `electron/captions/translation-policy.test.cjs`
- Modify: `electron/captions/caption-session-manager.js`
- Modify: `electron/captions/caption-foundation.test.cjs`

- [ ] **Step 1: Write the authority matrix tests**

```javascript
for (const row of [
  { final: 'luna', accel: false, early: true, preview: 'luna' },
  { final: 'luna', accel: true, early: true, preview: 'hy-mt2-local' },
  { final: 'hy-mt2-local', accel: false, early: true, preview: 'hy-mt2-local' },
  { final: 'hy-mt2-local', accel: true, early: true, preview: 'hy-mt2-local' },
  { final: 'luna', accel: true, early: false, preview: null },
]) {
  test(JSON.stringify(row), () => {
    const policy = createTranslationPolicy({
      finalTranslationModel: row.final,
      localTranslationAcceleration: row.accel,
      provisionalTranslation: row.early,
    });
    assert.equal(policy.previewBackend, row.preview);
    assert.equal(policy.finalBackend, row.final);
  });
}

test('late preview cannot replace an authoritative final', async () => {
  const state = translationState();
  state.acceptFinal({ utteranceId: 'u1', sourceRevision: 3, text: 'final' });
  assert.equal(state.acceptPreview({ utteranceId: 'u1', sourceRevision: 2, text: 'late' }), false);
});
```

- [ ] **Step 2: Implement the policy and refactor scheduling**

Move preview-backend selection, revision checks, and authoritative ownership into `translation-policy.js`. Keep the existing bounded provisional timer and per-item call cap. The manager owns separate `previewTranslator` and `finalTranslator` references; they may point to the same Hy-MT2 backend. Finalization cancels the preview controller, makes exactly one final request per target to the selected final backend, and only then appends the meeting record.

Do not alter the OpenAI-plus-Luna request shape, glossary compilation, fast-path routing, or default provisional cadence in this task.

- [ ] **Step 3: Run policy and main-track regression tests**

Run: `node --test electron/captions/translation-policy.test.cjs electron/captions/caption-foundation.test.cjs`

Expected: PASS, including current cloud provisional behavior.

- [ ] **Step 4: Commit**

```powershell
git add electron/captions/translation-policy.js electron/captions/translation-policy.test.cjs electron/captions/caption-session-manager.js electron/captions/caption-foundation.test.cjs
git commit -m "feat: separate translation acceleration from authority"
```

### Task 6: Enforce conditional credentials and fail-closed full-local startup

**Files:**
- Create: `electron/captions/local-privacy.test.cjs`
- Modify: `electron/captions/caption-session-manager.js`
- Modify: `electron/captions-main.js`

- [ ] **Step 1: Write the hard privacy test before changing startup**

```javascript
test('Whisper plus Hy-MT2 never touches cloud constructors or credentials', async () => {
  const forbidden = () => { throw new Error('cloud path touched'); };
  const manager = new CaptionSessionManager({
    credentialStore: { get: forbidden },
    settingsStore: fakeSettings({
      transcriptionModel: 'whisper-local', finalTranslationModel: 'hy-mt2-local',
      localTranslationAcceleration: true, provisionalTranslation: true,
    }),
    transcriptionBackendFactory: fakeLocalTranscriptionFactory(),
    translationBackendFactory: fakeLocalTranslationFactory(),
    cloudTranscriptionFactory: forbidden,
    cloudTranslationFactory: forbidden,
  });
  await manager.start({ mode: 'live' });
  assert.equal(manager.processing.fullyLocal, true);
  await manager.stop();
});
```

Add companion tests proving OpenAI+Hy-MT2 requires a key for ASR, Whisper+Luna requires a key for final text translation, and a missing selected local model blocks before meeting recording starts.

- [ ] **Step 2: Refactor startup in a strict order**

1. Resolve and freeze processing configuration.
2. Check selected local model readiness and prepare the host.
3. Read the credential only when `requiresCredential` is true.
4. Start the meeting record.
5. Construct only the selected transcription, preview, and final backends.
6. Connect channels and announce running.

If any step fails, close created resources, leave `active=false`, and emit a specific status code. Full-local never constructs `LiveTranscriptionSession`, `OpenAINormalizer`, or an OpenAI scheduler.

- [ ] **Step 3: Run privacy and foundation tests**

Run: `node --test electron/captions/local-privacy.test.cjs electron/captions/caption-foundation.test.cjs`

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add electron/captions/local-privacy.test.cjs electron/captions/caption-session-manager.js electron/captions-main.js
git commit -m "feat: fail closed for fully local meetings"
```

### Task 7: Persist authoritative model provenance only

**Files:**
- Modify: `electron/captions/caption-domain.js`
- Modify: `electron/captions/caption-foundation.test.cjs`
- Modify: `electron/captions/meeting-record-controller.js`
- Modify: `electron/captions/meeting-record-controller.test.cjs`
- Modify: `src/captions/types.ts`

- [ ] **Step 1: Test provenance and provisional exclusion**

```javascript
test('final records explain authoritative engines but omit preview text', () => {
  const event = createCaptionEvent({
    sessionId: 's1', sequence: 1, sourceChannel: 'microphone', providerItemId: 'u1',
    sourceText: 'Confirmed', transcriptStatus: 'final',
    transcription: { engine: 'whisper-local', model: 'whisper-small', runtime: 'openvino-genai', actualDevice: 'NPU' },
    translation: { engine: 'hy-mt2-local', model: 'hy-mt2-1.8b', runtime: 'openvino-genai', actualDevice: 'GPU' },
    localPreviewShown: true,
  });
  const saved = serializableFinalRecord(event);
  assert.equal(saved.provenance.transcription.actualDevice, 'NPU');
  assert.equal(saved.provenance.translation.actualDevice, 'GPU');
  assert.equal(saved.provenance.localPreviewShown, true);
  assert.equal('previewText' in saved, false);
});
```

- [ ] **Step 2: Extend the domain compatibly**

Add structured `provenance.transcription` and `provenance.translation` while retaining legacy provider fields during the migration. Update provenance when an authoritative result is accepted, not when a preview arrives. Persist source revision and finalization time. Existing meeting records without provenance remain readable.

- [ ] **Step 3: Run domain and record tests**

Run: `node --test electron/captions/caption-foundation.test.cjs electron/captions/meeting-record-controller.test.cjs`

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add electron/captions/caption-domain.js electron/captions/caption-foundation.test.cjs electron/captions/meeting-record-controller.js electron/captions/meeting-record-controller.test.cjs src/captions/types.ts
git commit -m "feat: persist authoritative inference provenance"
```

### Task 8: Add independent slide switches and readiness copy

**Files:**
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/ControlApp.test.tsx`
- Modify: `src/captions/captions.css`
- Modify: `src/captions/readiness.ts`
- Modify: `src/captions/readiness.test.ts`
- Modify: `src/captions/types.ts`
- Modify: `src/electron.d.ts`
- Modify: `electron/captions-preload.js`

- [ ] **Step 1: Write UI tests for independent choices and conditional readiness**

```tsx
it('saves transcription, final translation, and local acceleration independently', async () => {
  render(<ControlApp />);
  await user.click(screen.getByRole('radio', { name: 'Local Whisper' }));
  await user.click(screen.getByRole('radio', { name: 'Local Hy-MT2' }));
  await user.click(screen.getByRole('checkbox', { name: 'Use local translation acceleration' }));
  expect(window.captions.setSettings).toHaveBeenCalledWith(expect.objectContaining({ transcriptionModel: 'whisper-local' }));
  expect(window.captions.setSettings).toHaveBeenCalledWith(expect.objectContaining({ finalTranslationModel: 'hy-mt2-local' }));
});

it('does not block fully local start on a missing OpenAI key', () => {
  expect(reviewReadiness({ ...base, credentialAvailable: false, credentialRequired: false, localModelsReady: true }).canStart).toBe(true);
});
```

- [ ] **Step 2: Extend readiness inputs**

Add `credentialRequired` and `localModelsReady`. The credential step is blocking only when a selected backend needs OpenAI. A selected but unavailable local model adds a blocking `local-models` readiness step. Update the detail text for each combination: audio and text cloud, audio cloud/text local, audio local/text cloud, or fully local.

- [ ] **Step 3: Implement accessible slide switches**

Use two radio groups styled as segmented slide switches:

- `Transcription`: OpenAI live / Local Whisper
- `Final translation`: Luna / Local Hy-MT2

Keep the existing “Show early captions” toggle. Add “Use local translation acceleration” beneath it; disable that toggle when early captions are off and explain why. Show download/verify/remove actions, storage size, requested device, actual device, and actionable errors. Display the private-local badge only for Whisper plus Hy-MT2. Disable all engine controls during a meeting.

- [ ] **Step 4: Run UI and readiness tests**

Run: `npm test -- --run src/captions/ControlApp.test.tsx src/captions/readiness.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/captions/ControlApp.tsx src/captions/ControlApp.test.tsx src/captions/captions.css src/captions/readiness.ts src/captions/readiness.test.ts src/captions/types.ts src/electron.d.ts electron/captions-preload.js
git commit -m "feat: expose independent local inference controls"
```

### Task 9: Package and verify the host runtime

**Files:**
- Modify: `forge.config.js`
- Create: `electron/captions/local-inference-packaging.test.cjs`
- Modify: `.github/workflows/windows-ci.yml`
- Modify: `.github/workflows/windows-release.yml`
- Modify: `src/captions/aboutCredits.ts`
- Modify: `src/captions/aboutCredits.test.ts`
- Modify: `THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Write the packaging contract test**

```javascript
test('Windows packages stage the host runtime but not model weights', () => {
  const staged = localInferenceResources('win32');
  assert.ok(staged.some(row => row.name === 'twinscript-local-inference.exe'));
  assert.equal(staged.some(row => /whisper|hy-mt2|\.bin$|\.onnx$/.test(row.name)), false);
});
```

- [ ] **Step 2: Stage runtime resources explicitly**

Add a Windows-only `stageLocalInferenceResources` beside the native-camera staging hook. It copies the verified host directory into `process.resourcesPath/local-inference-host` and copies the signed manifest, signature, and public key from `artifacts/local-models`. It throws if the executable, runtime manifest, license, required DLL, or signed-model metadata is missing. It rejects files whose hashes differ from `runtime-manifest.json` and rejects model-weight extensions.

- [ ] **Step 3: Update CI and release attribution**

Windows CI builds the fake-engine host and runs protocol/package tests. Windows release builds the real host with the pinned OpenVINO toolchain before Electron packaging, signs the executable under the existing signature policy, and verifies the staged runtime. About and third-party notices name OpenVINO, Whisper, and Hy-MT2 and state that model weights download separately.

- [ ] **Step 4: Run packaging and full build tests**

Run: `node --test electron/captions/local-inference-packaging.test.cjs electron/captions/main-build-entries.test.cjs`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add forge.config.js electron/captions/local-inference-packaging.test.cjs .github/workflows/windows-ci.yml .github/workflows/windows-release.yml src/captions/aboutCredits.ts src/captions/aboutCredits.test.ts THIRD_PARTY_NOTICES.md
git commit -m "build: package the local inference runtime"
```

### Task 10: Validate all combinations and main-track non-regression

**Files:**
- Create: `electron/captions/processing-matrix.test.cjs`
- Create: `scripts/validate-local-inference.ps1`
- Create: `docs/validation/hybrid-full-local-matrix.md`

- [ ] **Step 1: Generate the 16-case policy matrix test**

Cross both transcription engines, both final translation engines, acceleration on/off, and early captions on/off. For each row assert selected constructors, whether a credential is read, preview backend, final backend, and whether the privacy flag is true. Assert exactly one authoritative persisted result per target.

- [ ] **Step 2: Run automated regression suites**

Run: `node --test electron/captions/*.test.cjs scripts/release/*.test.cjs`

Run: `npm test -- --run`

Run: `npm run build`

Expected: all PASS. The existing OpenAI-plus-Luna tests remain unchanged except for explicit new default settings.

- [ ] **Step 3: Run the hardware matrix**

`validate-local-inference.ps1` accepts the local model root, runs the four engine pairs with early/acceleration variants, records first transcript, final transcript, first translation, authoritative translation, queue depth, model load count, requested/actual device, and all network endpoints. It cycles the bilingual corpus for 60 minutes in full-local mode.

Expected release gates:

- full local makes zero OpenAI calls and never reads the credential;
- NPU is reported only when the host reports NPU;
- model load count remains one per prepared model;
- maximum queues remain bounded;
- warm local acceleration improves median first translated caption by at least 30 percent against the same final-model path without acceleration;
- names, numbers, units, and glossary terms meet the approved quality thresholds;
- current OpenAI-plus-Luna latency does not materially regress.

- [ ] **Step 4: Record results without private content**

Write aggregate metrics, device evidence, pass/fail, app/runtime/model versions, and failure codes to `docs/validation/hybrid-full-local-matrix.md`. Do not include private audio or transcript text.

- [ ] **Step 5: Commit the validation assets and reviewed aggregate report**

```powershell
git add electron/captions/processing-matrix.test.cjs scripts/validate-local-inference.ps1 docs/validation/hybrid-full-local-matrix.md
git commit -m "test: validate hybrid and full-local processing matrix"
```

### Task 11: Final verification checkpoint

- [ ] **Step 1: Verify no unrelated shared-worktree changes entered feature commits**

Run: `git status --short`

Run: `git diff main...HEAD --name-only`

Expected: the pre-existing audio-capture/worklet changes are absent unless their owner intentionally committed them separately.

- [ ] **Step 2: Run the complete release-equivalent verification**

Run: `npm run test:captions`

Run: `npm test -- --run`

Run: `npm run build`

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-local-inference-host.ps1 -HostDirectory artifacts/local-inference-host`

Expected: all PASS.

- [ ] **Step 3: Manually confirm the four user-visible engine pairs**

Verify OpenAI/Luna, OpenAI/Hy-MT2, Whisper/Luna, and Whisper/Hy-MT2. For each, confirm settings lock during the meeting, displayed device matches host evidence, provisional text is visibly non-final, selected final model governs the persisted output, and the privacy copy matches actual data flow.
