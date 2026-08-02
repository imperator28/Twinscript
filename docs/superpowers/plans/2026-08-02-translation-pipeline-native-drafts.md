# Translation Pipeline and Native Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Luna finals current under load and add optional, cancellable on-device draft translation through Windows NPU and macOS Translation framework backends.

**Architecture:** Cloud final work uses a reserved-capacity scheduler, one request per utterance, and bounded rolling context. A versioned main-process protocol owns local helpers; the renderer only sees availability/progress settings and caption draft states. Windows uses an INT4 Hy-MT2 artifact through Windows ML execution providers; macOS uses a SwiftUI agent hosting Apple's low-latency Translation framework.

**Tech Stack:** Node/Electron, OpenAI Responses API, Windows App SDK/Windows ML, ONNX Runtime GenAI, C# .NET 8 helper, Swift 6/SwiftUI Translation framework, Vitest and Node tests.

---

## File map

- Modify `electron/captions/priority-task-queue.js`: reserve capacity for final work.
- Modify `electron/captions/caption-foundation.test.cjs`: scheduler, settings, and normalizer tests.
- Modify `electron/captions/openai-normalizer.js`: joint bilingual response and rolling context.
- Modify `electron/captions/caption-session-manager.js`: one final request, source pass-through, context, and draft orchestration.
- Create `electron/captions/local-draft-protocol.js`: validated helper messages.
- Create `electron/captions/local-draft-manager.js`: lifecycle, cancellation, and stale-result guards.
- Create `electron/captions/local-draft-manager.test.cjs`: deterministic fake-helper tests.
- Modify `electron/captions/settings-store.js`, `src/captions/types.ts`, and preload typings: local-draft settings/status.
- Modify `electron/captions/register-caption-ipc.js` and `electron/captions-preload.js`: trusted control IPC.
- Modify `src/captions/ControlApp.tsx`, `ControlApp.test.tsx`, and `captions.css`: shared preparation UI.
- Create `native/local-translation/windows/Bilingual.LocalTranslation.csproj` and `Program.cs`: Windows helper.
- Create `scripts/export-hy-mt2-winml.ps1`: pinned INT4 artifact conversion and manifest.
- Create `native/local-translation/macos/Package.swift` and Swift sources: macOS agent helper.
- Modify `forge.config.js`: platform-specific helper packaging without Windows resources on macOS.
- Create `docs/validation/local-draft-validation.md`: latency, quality, and accelerator evidence.

### Task 1: Reserve cloud capacity for final translations

**Files:**
- Modify: `electron/captions/priority-task-queue.js`
- Test: `electron/captions/caption-foundation.test.cjs`

- [ ] **Step 1: Write a failing reserved-slot test**

```js
test('priority queue keeps one slot available for final work', async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const queue = new PriorityTaskQueue({
    concurrency: 2,
    maxQueue: 8,
    reservedHighSlots: 1,
    highPriority: 10,
  });
  const started = [];
  let releaseFirst;
  const p1 = queue.run(() => new Promise((resolve) => {
    started.push('draft-1');
    releaseFirst = resolve;
  }), { priority: 0 });
  const p2 = queue.run(async () => started.push('draft-2'), { priority: 0 });
  await tick();
  assert.deepEqual(started, ['draft-1']);
  const final = queue.run(async () => started.push('final'), { priority: 10 });
  await final;
  assert.deepEqual(started, ['draft-1', 'final']);
  releaseFirst();
  await Promise.all([p1, p2]);
  assert.deepEqual(started, ['draft-1', 'final', 'draft-2']);
});
```

- [ ] **Step 2: Verify the test fails**

Run `node --test electron/captions/caption-foundation.test.cjs`.

Expected: FAIL because both low-priority tasks start immediately.

- [ ] **Step 3: Implement lane-aware draining**

Extend the constructor with `reservedHighSlots = 0` and `highPriority = 10`.
Track `runningHigh` and choose the first runnable queued item:

```js
canRun(item) {
  if (item.priority >= this.highPriority) return this.running < this.concurrency;
  return this.running < this.concurrency - this.reservedHighSlots;
}

nextRunnableIndex() {
  return this.queue.findIndex((item) => this.canRun(item));
}
```

Increment/decrement `runningHigh` for high-priority work and include
`runningHigh` in `snapshot()`.

- [ ] **Step 4: Enable one reserved final slot**

In `CaptionSessionManager`, instantiate:

```js
new PriorityTaskQueue({
  concurrency: 2,
  maxQueue: 24,
  reservedHighSlots: 1,
  highPriority: 10,
});
```

- [ ] **Step 5: Run caption tests**

Run `npm run test:captions`.

Expected: PASS. If commits are authorized, checkpoint with
`perf: reserve cloud translation capacity`.

### Task 2: Use one Luna final request per utterance

**Files:**
- Modify: `electron/captions/openai-normalizer.js`
- Modify: `electron/captions/caption-session-manager.js:525-606`
- Test: `electron/captions/caption-foundation.test.cjs`

- [ ] **Step 1: Write failing request-count tests**

Export a pure `buildNormalizationPlan(routedAs, final)` helper and test it
without inventing a second session harness:

```js
test('English final passes through English and requests Chinese once', () => {
  assert.deepEqual(buildNormalizationPlan('en', true), {
    mode: 'single', passthrough: 'en', targets: ['zh'],
  });
});

test('mixed final uses one joint bilingual request', () => {
  assert.deepEqual(buildNormalizationPlan('mixed', true), {
    mode: 'bilingual', passthrough: null, targets: ['en', 'zh'],
  });
});
```

- [ ] **Step 2: Verify current behavior fails**

Run `node --test electron/captions/caption-foundation.test.cjs`.

Expected: FAIL because final currently requests both targets independently.

- [ ] **Step 3: Add a joint schema and `normalizeBilingual`**

```js
const BILINGUAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source_language', 'english', 'chinese'],
  properties: {
    source_language: { type: 'string', enum: ['en', 'zh', 'mixed', 'unknown'] },
    english: { type: 'string' },
    chinese: { type: 'string' },
  },
};
```

Implement `normalizeBilingual` with the same retry, usage, glossary, protected
token, scheduler, and redaction behavior as `normalize`, but one Responses API
request and one structured object.

- [ ] **Step 4: Route monolingual and mixed finals**

Implement and export:

```js
function buildNormalizationPlan(routedAs, final) {
  if (final && routedAs === 'en') {
    return { mode: 'single', passthrough: 'en', targets: ['zh'] };
  }
  if (final && routedAs === 'zh') {
    return { mode: 'single', passthrough: 'zh', targets: ['en'] };
  }
  if (final || routedAs === 'mixed' || routedAs === 'unknown') {
    return { mode: 'bilingual', passthrough: null, targets: ['en', 'zh'] };
  }
  return { mode: 'single', passthrough: null,
    targets: [routedAs === 'en' ? 'zh' : 'en'] };
}
```

For a final monolingual caption, mark its source-language target final with
`passthrough: true` and call `normalize` once for the opposite target. For
`mixed` or `unknown`, call `normalizeBilingual` once and update both targets
atomically.

- [ ] **Step 5: Run tests and inspect request accounting**

Run `npm run test:captions`.

Expected: PASS; monolingual final cost records one call and mixed final records
one joint call.

### Task 3: Add bounded rolling context

**Files:**
- Modify: `electron/captions/openai-normalizer.js`
- Modify: `electron/captions/caption-session-manager.js`
- Test: `electron/captions/caption-foundation.test.cjs`

- [ ] **Step 1: Write a failing context-bound test**

```js
test('settled context retains only the two newest pairs', () => {
  let context = [];
  for (const sourceText of ['one', 'two', 'three']) {
    context = appendSettledContext(context, {
      sourceText, english: `${sourceText}-en`, chinese: `${sourceText}-zh`,
    });
  }
  assert.deepEqual(context.map((row) => row.sourceText), ['two', 'three']);
});
```

- [ ] **Step 2: Verify it fails**

Run the focused Node test; expected FAIL because no context is supplied.

- [ ] **Step 3: Maintain and pass a two-row settled context**

Export the pure helper and initialize `this.settledContext = []`:

```js
function appendSettledContext(context, row) {
  return [...context, row].slice(-2);
}

this.settledContext = appendSettledContext(this.settledContext, {
  sourceText: primary.sourceText, english: primary.english.text,
  chinese: primary.chinese.text,
});
```

Snapshot the array before each new request and pass it as `context`.

- [ ] **Step 4: Serialize context separately from the current utterance**

Add a bounded system-content suffix:

```js
function contextPrompt(context = []) {
  if (!context.length) return '';
  const rows = context.slice(-2).map((row, index) =>
    `${index + 1}. SOURCE: ${row.sourceText}\nEN: ${row.english}\nZH: ${row.chinese}`,
  );
  return `\nRecent settled context (reference only):\n${rows.join('\n')}`;
}
```

Cap the serialized suffix at 1,200 characters.

- [ ] **Step 5: Run caption tests**

Run `npm run test:captions`.

Expected: PASS.

### Task 4: Add the local-draft protocol and lifecycle manager

**Files:**
- Create: `electron/captions/local-draft-protocol.js`
- Create: `electron/captions/local-draft-manager.js`
- Create: `electron/captions/local-draft-manager.test.cjs`

- [ ] **Step 1: Write failing protocol and stale-result tests**

```js
test('stale helper result is discarded after revision cancellation', async () => {
  const helper = fakeHelper();
  const drafts = [];
  const manager = new LocalDraftManager({ helper, onDraft: (draft) => drafts.push(draft) });
  manager.translate({ captionId: 'a', revision: 1, sourceText: 'old', source: 'en', target: 'zh' });
  manager.translate({ captionId: 'a', revision: 2, sourceText: 'new', source: 'en', target: 'zh' });
  helper.resolve({ requestId: helper.requests[0].requestId, text: '旧' });
  assert.deepEqual(drafts, []);
});
```

Also reject messages over 64 KiB, unknown versions, unknown types, missing IDs,
and text over 4,000 characters.

- [ ] **Step 2: Verify tests fail because files do not exist**

Run `node --test electron/captions/local-draft-manager.test.cjs`.

Expected: FAIL with module-not-found.

- [ ] **Step 3: Define versioned message constructors and validators**

```js
const PROTOCOL_VERSION = 1;
const REQUEST_TYPES = new Set(['probe', 'prepare', 'translate', 'cancel', 'remove', 'dispose']);

function request(type, requestId, payload = {}) {
  if (!REQUEST_TYPES.has(type)) throw new TypeError('Unsupported local draft request');
  return { version: PROTOCOL_VERSION, type, requestId, payload };
}
```

Export `parseMessage`, `request`, and `MAX_MESSAGE_BYTES`.

- [ ] **Step 4: Implement one-current-revision lifecycle**

`LocalDraftManager` owns a helper process adapter, a request map, and
`latestRevisionByCaption`. A newer revision sends `cancel` for the previous
request. A result is emitted only if caption ID, revision, and source text still
match. Dispose rejects all pending requests and terminates the helper. Restart
the helper once after an unexpected exit when no request is active; a second
exit sets status `failed` and disables drafts for the current session.

- [ ] **Step 5: Run local manager tests**

Run `node --test electron/captions/local-draft-manager.test.cjs`.

Expected: PASS.

### Task 5: Integrate local drafts without delaying cloud final work

**Files:**
- Modify: `electron/captions/caption-session-manager.js`
- Modify: `electron/captions/caption-domain.js`
- Test: `electron/captions/caption-foundation.test.cjs`

- [ ] **Step 1: Write failing orchestration tests**

Cover: stable partial starts local work; newer partial cancels it; final starts
Luna immediately; local-after-final is ignored; local-before-final renders as
provisional; only final enters the record controller.

```js
assert.equal(harness.recordController.rows.length, 1);
assert.equal(harness.recordController.rows[0].chinese.status, 'final');
assert.notEqual(harness.recordController.rows[0].chinese.text, 'local draft');
```

- [ ] **Step 2: Verify failures**

Run `node --test electron/captions/caption-foundation.test.cjs`.

Expected: FAIL because no local manager is wired.

- [ ] **Step 3: Route provisional work to the local manager when ready**

Keep the existing bounded debounce, but call `localDraftManager.translate()`
instead of Luna provisional when `localDraftEnabled && manager.ready`. If the
local helper is unavailable, preserve the current cloud-provisional setting as
the fallback only when explicitly enabled by profile.

- [ ] **Step 4: Make finalization cancel local work before queueing Luna**

At final transcript receipt, cancel the caption's local request, publish the
final source state, and call `normalizeFinal` without awaiting helper shutdown.

- [ ] **Step 5: Run caption tests**

Run `npm run test:captions`.

Expected: PASS, with draft text absent from all persisted records.

### Task 6: Add settings, IPC, and shared preparation UI

**Files:**
- Modify: `electron/captions/settings-store.js`
- Modify: `src/captions/types.ts`
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-preload.js`
- Modify: `src/electron.d.ts`
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/ControlApp.test.tsx`

- [ ] **Step 1: Write failing settings and UI tests**

Assert defaults `localDraftEnabled: false` and
`localDraftAllowGpuFallback: true`. In the renderer, enable Instant local draft
and assert Start session remains enabled while status is `preparing`.

- [ ] **Step 2: Run focused tests and verify failure**

Run `npm run test:captions` and
`npx vitest run src/captions/ControlApp.test.tsx`.

Expected: FAIL on missing settings/status methods.

- [ ] **Step 3: Add validated settings and a read-only status contract**

```ts
export interface LocalDraftStatus {
  state: 'off' | 'not-installed' | 'preparing' | 'ready' | 'failed';
  engine: 'windows-ml' | 'apple-translation' | 'unavailable';
  accelerator?: string;
  progress?: number;
  storageBytes?: number;
  message?: string;
}
```

Expose `getLocalDraftStatus`, `prepareLocalDraft`, `removeLocalDraft`, and an
`onLocalDraftStatus` subscription through sender-validated IPC. Extend metrics
with `{ translationBacklog: { running, queued, oldestAgeMs } }` so the renderer
can show one nonblocking `Final translation catching up` status when queue age
exceeds one second.

- [ ] **Step 4: Add the Settings card**

Render Instant local draft, engine/accelerator, size, progress, retry, and
remove controls. Preparation is nonmodal and does not disable Start session.

- [ ] **Step 5: Run settings and UI tests**

Run both focused commands; expected PASS.

### Task 7: Build the Windows Windows-ML helper and artifact pipeline

**Files:**
- Create: `native/local-translation/windows/Bilingual.LocalTranslation.csproj`
- Create: `native/local-translation/windows/Program.cs`
- Create: `scripts/export-hy-mt2-winml.ps1`
- Modify: `forge.config.js`

- [ ] **Step 1: Create a protocol-only helper test mode**

The C# helper accepts newline-delimited JSON and supports `--self-test`. Its
self-test emits:

```json
{"version":1,"type":"probe-result","requestId":"self-test","payload":{"available":true,"engine":"windows-ml"}}
```

Run `dotnet run --project native/local-translation/windows -- --self-test`.

Expected: one valid JSON line and exit 0.

- [ ] **Step 2: Add Windows ML provider discovery**

Reference Windows App SDK and ONNX Runtime GenAI. Use
`ExecutionProviderCatalog.GetDefault().FindAllProviders()` and select in order:
OpenVINO, QNN, VitisAI, then approved GPU provider. `prepare` calls
`EnsureReadyAsync()` only after user action and registers ready providers.

- [ ] **Step 3: Add deterministic Hy-MT2 generation**

Load the versioned model directory, set greedy decoding, bound input to 512
tokens and output to 180 tokens, and honor cancellation between generated
tokens. Return provider name and elapsed milliseconds in every result.

- [ ] **Step 4: Add pinned artifact export**

The PowerShell script creates an isolated venv, pins OpenVINO/Optimum/Transformers
versions documented in the spec references, exports symmetric INT4 stateful
weights, runs EN/ZH smoke input, writes SHA-256 hashes plus source revision to
`model-manifest.json`, and refuses to replace an existing verified artifact on
failure.

- [ ] **Step 5: Run the hardware gate on the development PC**

Run the export only after approving the on-demand model download. Then run
helper probe and translation smoke tests.

Expected: provider is OpenVINO, device identifies Intel AI Boost, both directions
return nonempty target-language output, and no CPU-only fallback is labeled NPU.

- [ ] **Step 6: Package Windows helper only on win32**

Extend `stageNativeCameraResources` with a separate
`stageLocalTranslationResources` function that includes the helper executable
but never the model weights. Verify `npm run make` stages it under
`resources/local-translation/windows`.

### Task 8: Build the macOS Translation helper agent

**Files:**
- Create: `native/local-translation/macos/Package.swift`
- Create: `native/local-translation/macos/Sources/BilingualTranslationHost/App.swift`
- Create: `native/local-translation/macos/Sources/BilingualTranslationHost/TranslationController.swift`
- Create: `native/local-translation/macos/Sources/BilingualTranslationHost/Protocol.swift`
- Modify: `forge.config.js`

- [ ] **Step 1: Add protocol unit tests in the Swift package**

Decode probe, prepare, translate, cancel, and dispose messages; reject unknown
versions and oversized text. Run `swift test` on macOS.

Expected: PASS.

- [ ] **Step 2: Implement availability and installed-language inference**

Use a runtime availability guard. On macOS 26 or newer, probe with
`LanguageAvailability(preferredStrategy: .lowLatency)` and create:

```swift
let session = TranslationSession(
    installedSource: Locale.Language(identifier: source),
    target: Locale.Language(identifier: target),
    preferredStrategy: .lowLatency
)
let response = try await session.translate(text)
```

Return `response.targetText`; `cancel` calls `session.cancel()`.
On macOS 15 through 25, use `LanguageAvailability()` and
`TranslationSession(installedSource:target:)`, whose SDK default uses the
traditional on-device model. This keeps the feature available without calling
newer symbols on older systems.

- [ ] **Step 3: Implement first-time preparation through a SwiftUI host view**

Create an `LSUIElement` agent whose hidden root view owns a
`TranslationSession.Configuration`. A prepare message sets EN/ZH configuration,
invalidates it, and the `.translationTask` closure calls
`prepareTranslation()`, allowing macOS to show its required permission UI.
Before sending source text, replace each matched protected token with a stable
private-use placeholder such as `\u{E000}0\u{E001}`; restore the exact literal
tokens in the translated response and fail the draft if any placeholder is
lost.

- [ ] **Step 4: Build a universal helper and package only on darwin**

Build x86_64 and arm64 release binaries, combine with `lipo`, and stage the
agent under `resources/local-translation/macos`. Add its usage strings and
codesign it with the same identity as the parent app.

- [ ] **Step 5: Run macOS parity smoke tests**

On macOS 15 or newer, test availability, download permission, EN/ZH translation,
cancellation, app restart, overlays, preview, recording, and records. On an
Intel Mac, accept system translation if reported available; otherwise verify
the UI remains cloud-final capable without errors.

### Task 9: Run latency, quality, privacy, and build gates

**Files:**
- Create: `docs/validation/local-draft-validation.md`

- [ ] **Step 1: Add a fixed bilingual fixture**

Include 5-, 15-, and 30-word EN/ZH utterances, engineering glossary tokens,
mixed speech, numbers, units, and uncertainty phrases. Store text and expected
token-preservation assertions, not meeting audio.

Assert the existing realtime configuration still names
`gpt-live-transcribe`; this plan does not change the transcription model.

- [ ] **Step 2: Measure required performance**

Record warm p50/p95, provider, cancellation count, final queue age, and
transcription event latency. Gates are p50 <= 700 ms, p95 <= 1,200 ms, no stale
draft render, bounded final queue, and <= 50 ms p95 transcription regression.

- [ ] **Step 3: Run full automated verification**

```powershell
npm run test:captions
npx vitest run
npm run build
```

Expected: all commands exit 0. Run Windows helper self-test on Windows and
`swift test` plus helper smoke tests on macOS.

- [ ] **Step 4: Inspect packaged artifacts**

Expected: no model weights bundled; Windows contains only the Windows helper;
macOS contains only the signed macOS agent; no helper receives API keys or
audio; draft text is absent from saved records.

- [ ] **Step 5: Record pending manual evidence honestly**

Mark NPU and macOS measurements complete only from their respective physical
machines. Do not infer Apple Neural Engine use when the API does not expose it.
