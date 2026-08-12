# Offline Session Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow keyless fully local meetings and make every startup, camera-health, and shutdown outcome visible and recoverable to the operator.

**Architecture:** Keep the existing `reviewReadiness` checklist as the one source of truth for the Start gate, but add explicit routing guidance when a selected cloud stage has no key. Make the renderer resilient to the main-process IPC boot race and make `CaptionSessionManager.stop()` bound the two remaining finalization awaits. The renderer always rolls an audio-start failure back to idle once the bounded stop completes.

**Tech Stack:** Electron IPC, React 19, TypeScript, Node `node:test`, Vitest 4.

---

## File structure

- `src/captions/readiness.ts`: operator-facing missing-key guidance and the action label for selecting the local route.
- `src/captions/readiness.test.ts`: pure checklist coverage for the cloud and keyless-local paths.
- `src/captions/ControlApp.tsx`: bounded initial camera-health retry, start rollback, output-mode explanation, and checklist action routing.
- `src/captions/ControlApp.test.tsx`: renderer coverage for retry, microphone-start rollback, and setup copy.
- `electron/captions/caption-session-manager.js`: bounded evaluation-recording and meeting-record finalization during `stop()`.
- `electron/captions/caption-foundation.test.cjs`: main-process coverage for stalled finalization tasks.

### Task 1: Make the missing-key checklist teach the two available routes

**Files:**

- Modify: `src/captions/readiness.ts:78-88`
- Modify: `src/captions/readiness.test.ts:22-38`
- Modify: `src/captions/ControlApp.tsx:1205-1216`
- Test: `src/captions/ControlApp.test.tsx`

- [ ] **Step 1: Write the failing checklist test**

  Add this test after `blocks Start only for a missing API key`:

  ```ts
  it('explains the keyless fully local route when a selected cloud stage needs a key', () => {
    const review = reviewReadiness({ ...ready, credentialAvailable: false });
    const credential = review.steps.find((step) => step.id === 'credential');

    expect(credential).toMatchObject({
      title: 'Choose a caption route',
      action: 'Choose route',
    });
    expect(credential?.detail).toMatch(/Whisper local.*HY-MT2 local/i);
    expect(credential?.detail).toMatch(/OpenAI API key/i);
  });
  ```

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `npm test -- --run src/captions/readiness.test.ts`

  Expected: the assertion fails because the current title is `Add your OpenAI API key` and the detail has no local route.

- [ ] **Step 3: Implement the checklist wording and route action**

  Replace the credential step with this user-facing contract:

  ```ts
  steps.push({
    id: 'credential',
    title: 'Choose a caption route',
    detail:
      'This selection uses OpenAI. Add an OpenAI API key, or switch to Whisper local and HY-MT2 local for a fully offline meeting.',
    done: input.credentialAvailable,
    severity: 'blocking',
    action: 'Choose route',
  });
  ```

  In `ControlApp.tsx`, change the `credential` branch of `resolveReadiness` so it selects the Settings tab rather than immediately focusing the API-key input. Keep the key field available there; the user decides between the cloud and local controls.

- [ ] **Step 4: Add the renderer action test**

  In `ControlApp.test.tsx`, set `credentialStatus` to return `{ available: false }`, render the app, click `Choose route`, and assert that the Settings tab is selected and that both `OpenAI live` and `Whisper local` are visible.

- [ ] **Step 5: Run the focused renderer and readiness tests**

  Run: `npm test -- --run src/captions/readiness.test.ts src/captions/ControlApp.test.tsx`

  Expected: both test files pass.

- [ ] **Step 6: Commit the checklist guidance**

  ```bash
  git add src/captions/readiness.ts src/captions/readiness.test.ts src/captions/ControlApp.tsx src/captions/ControlApp.test.tsx
  git commit -m "feat: guide keyless users to local caption models"
  ```

### Task 2: Retry the initial virtual-camera health request

**Files:**

- Modify: `src/captions/ControlApp.tsx:310-420`
- Modify: `src/captions/ControlApp.test.tsx:159-360`

- [ ] **Step 1: Write the failing retry test**

  Add a test that configures:

  ```ts
  window.captions.getNativeCameraHealth = vi
    .fn()
    .mockRejectedValueOnce(new Error('No handler registered'))
    .mockResolvedValueOnce({
      ok: true,
      data: { state: 'installed', supported: true, installed: true, message: null },
    });
  ```

  Render `ControlApp`, wait for the second call, and assert that the virtual-camera card no longer contains `Checking the virtual camera` and instead contains `Twinscript is listed as a camera`.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `npm test -- --run src/captions/ControlApp.test.tsx -t "retries virtual camera health"`

  Expected: the mocked request is called once and the card stays in its checking state.

- [ ] **Step 3: Implement a bounded initial retry**

  Inside the mount effect, replace the one-shot `getNativeCameraHealth()` invocation with a local `refreshNativeCameraHealth(attempt = 0)` function. It must:

  ```ts
  const MAX_CAMERA_HEALTH_ATTEMPTS = 3;
  const CAMERA_HEALTH_RETRY_MS = 150;

  const refreshNativeCameraHealth = (attempt = 0) => {
    void window.captions.getNativeCameraHealth().then((result) => {
      if (mounted && result.ok) setNativeCameraHealth(result.data);
    }).catch(() => {
      if (mounted && attempt + 1 < MAX_CAMERA_HEALTH_ATTEMPTS) {
        window.setTimeout(() => refreshNativeCameraHealth(attempt + 1), CAMERA_HEALTH_RETRY_MS);
      }
    });
  };
  ```

  Call it once after registering the health listener. Store and clear the retry timer in effect cleanup so an unmounted control window cannot update state later.

- [ ] **Step 4: Run the retry test and the complete ControlApp suite**

  Run: `npm test -- --run src/captions/ControlApp.test.tsx`

  Expected: `ControlApp.test.tsx` passes, including the retry test.

- [ ] **Step 5: Commit the boot-race recovery**

  ```bash
  git add src/captions/ControlApp.tsx src/captions/ControlApp.test.tsx
  git commit -m "fix: retry virtual camera health during app startup"
  ```

### Task 3: Return the renderer to idle after microphone-start failure

**Files:**

- Modify: `src/captions/ControlApp.tsx:634-725`
- Modify: `src/captions/ControlApp.test.tsx:1482-1555`

- [ ] **Step 1: Write the failing rollback test**

  Add a test with:

  ```ts
  audioMocks.start.mockRejectedValueOnce(new Error('Could not start the selected microphone'));
  window.captions.stopSession = vi.fn(() => new Promise(() => {}));
  ```

  Click Start, wait for `window.captions.stopSession`, advance fake timers by
  8 seconds, then assert all of these:

  ```ts
  expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled();
  expect(screen.getByText('Could not start the selected microphone')).toBeVisible();
  expect(channelBadge('You / microphone')).toBeNull();
  expect(channelBadge('Meeting / system')).toBeNull();
  ```

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `npm test -- --run src/captions/ControlApp.test.tsx -t "returns to idle when microphone capture fails"`

  Expected: it fails because `start()` remains pending on `stopSession()` and no timeout returns the UI to idle.

- [ ] **Step 3: Implement bounded renderer cleanup**

  Add a local `stopMainSessionForRecovery()` helper in `ControlApp`. Race `window.captions.stopSession()` against an 8-second timer that resolves a `{ timedOut: true }` result. Use it from both the audio-start `catch` and the user `stop()` handler. In either case, reset `status`, `capture`, `sessionActive`, `operation`, and `busy` in a `finally` block. If the fallback timer wins, display:

  ```ts
  'Twinscript is still finishing in the background. You can start a new session after it reports stopped.'
  ```

  Preserve the existing behavior where a system-loopback failure is advisory when microphone capture succeeds.

- [ ] **Step 4: Clarify the virtual-camera selection**

  Directly below the virtual-camera output-mode note, render this copy only for `settings.outputMode === 'virtual-camera'`:

  ```tsx
  <p className="supporting-copy">
    Virtual camera sends captions to Teams, Zoom, or OBS. Camera Stage is only your preview; choose On-screen captions for desktop overlays.
  </p>
  ```

  Add a renderer test that selects virtual camera and asserts this text is visible.

- [ ] **Step 5: Run the focused ControlApp suite**

  Run: `npm test -- --run src/captions/ControlApp.test.tsx`

  Expected: the microphone rollback, output explanation, and existing capture tests pass.

- [ ] **Step 6: Commit the renderer recovery**

  ```bash
  git add src/captions/ControlApp.tsx src/captions/ControlApp.test.tsx
  git commit -m "fix: recover the session UI after audio startup failure"
  ```

### Task 4: Bound every main-process shutdown stage

**Files:**

- Modify: `electron/captions/caption-session-manager.js:70-180,1156-1242`
- Modify: `electron/captions/caption-foundation.test.cjs:1395-1434`

- [ ] **Step 1: Write failing tests for stalled finalizers**

  Add two `node:test` cases that construct an active manager with a 10 ms timeout and an unresolved promise:

  ```js
  test('stop proceeds when evaluation recording never settles', async () => {
    const statuses = [];
    const manager = new CaptionSessionManager({
      credentialStore: {},
      settingsStore: {},
      evaluationStopTimeoutMs: 10,
      onStatus: (status) => statuses.push(status),
      evaluationRecorder: { stop: () => new Promise(() => {}) },
    });
    manager.active = true;

    await manager.stop();

    assert.equal(manager.active, false);
    assert.ok(statuses.some((status) => status.code === 'evaluation_shutdown_timeout'));
  });
  ```

  Add the equivalent meeting-record test using `mode = 'live'`, `meetingRecordController.stopSession = () => new Promise(() => {})`, and the expected code `meeting_record_shutdown_timeout`.

- [ ] **Step 2: Run the focused tests and verify they fail**

  Run: `node --test electron/captions/caption-foundation.test.cjs --test-name-pattern "never settles"`

  Expected: each new test times out because the current `await evaluationRecorder.stop()` and `await meetingRecordController.stopSession()` have no deadline.

- [ ] **Step 3: Implement a shared bounded await in CaptionSessionManager**

  Add constructor defaults:

  ```js
  this.evaluationStopTimeoutMs = options.evaluationStopTimeoutMs ?? 5_000;
  this.meetingRecordStopTimeoutMs = options.meetingRecordStopTimeoutMs ?? 5_000;
  ```

  Add `awaitBounded(promise, timeoutMs)` beside the other manager helpers. It races completion against an unref’d timer and returns `{ timedOut: false, value }` or `{ timedOut: true }` without throwing from the timer branch.

  Use it for `evaluationRecorder.stop()` and live `meetingRecordController.stopSession()`. On timeout, emit the codes asserted above and continue to the final `stopped` status. On successful meeting-record completion, retain the returned record as today.

- [ ] **Step 4: Run the focused main-process test and full caption suite**

  Run: `node --test electron/captions/caption-foundation.test.cjs`

  Run: `npm run test:captions`

  Expected: both commands exit 0; shutdown still waits for a responsive final transcript but no longer waits forever for unresponsive finalizers.

- [ ] **Step 5: Commit the bounded finalization**

  ```bash
  git add electron/captions/caption-session-manager.js electron/captions/caption-foundation.test.cjs
  git commit -m "fix: bound session shutdown finalization"
  ```

### Task 5: Verify the offline path in the reviewed client

**Files:**

- Modify: `src/captions/ControlApp.test.tsx` only if the keyless route’s visible settings controls need a final assertion.

- [ ] **Step 1: Add the keyless local UI regression assertion**

  In the Settings test fixture, return no credential and local model status with both models `ready`. Select Whisper local and HY-MT2 local, then assert:

  ```ts
  expect(screen.getByText(/fully local\. No API key is read when a meeting starts/i)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled();
  ```

- [ ] **Step 2: Run the full renderer suite**

  Run: `npm test -- --run`

  Expected: all Vitest files pass.

- [ ] **Step 3: Build the application**

  Run: `npm run build`

  Expected: exit code 0 and `dist-electron/captions-main.js` is emitted.

- [ ] **Step 4: Manual smoke check with the dev app**

  Run: `npm run dev`

  In the open app:

  1. Remove or leave blank the API key.
  2. Select Whisper local and HY-MT2 local, and confirm both local-model rows are Ready.
  3. Select On-screen captions and confirm the setup explanation distinguishes it from Virtual camera.
  4. Select a working microphone, start, speak one English sentence, and confirm a bilingual caption reaches the overlay or Camera Stage.
  5. Stop and confirm the control returns to Start session within the configured bounded shutdown time.

- [ ] **Step 5: Commit the final regression coverage**

  ```bash
  git add src/captions/ControlApp.test.tsx
  git commit -m "test: cover keyless local session readiness"
  ```
