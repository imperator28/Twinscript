# W2 Records, History, and Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the approved W2 meeting-record, operator-review, visible-history, and glossary-budget behavior so a packaged Windows/macOS build is ready for owner validation.

**Architecture:** Keep filesystem, encryption, recovery, dialogs, and native-window resizing in the Electron main process. `CaptionSessionManager` remains the live-session orchestrator and talks to `MeetingRecordController` through a narrow injected interface; preload exposes named record and overlay methods only. Renderer state renders backup/recovery decisions and complete-entry history without receiving keys or unrestricted filesystem access.

**Tech Stack:** Electron 34, CommonJS main/preload modules, React 19 + TypeScript, Node `node:test`, Vitest + Testing Library, Vite Electron build.

---

## File map

- `electron/captions/meeting-record-*.js`, `encrypted-audio-writer.js`, `recording-key-store.js`, `wav-finalizer.js`: existing W2a mechanisms; preserve their focused responsibilities.
- `electron/captions/caption-session-manager.js`: start/append/finalize/stop integration and glossary request-context selection.
- `electron/captions/register-caption-ipc.js`: validated record, folder, retention, reveal/export, and overlay-height IPC.
- `electron/captions-preload.js`: named renderer API and event subscriptions.
- `electron/captions-main.js`: construct/recover/destroy record services and broadcast their state.
- `electron/captions/caption-window-manager.js`, `overlay-layout.js`: immediate caption presentation and bottom-anchored measured layout.
- `electron/captions/glossary-request-context.js`: pure 16-row/800-character compiler.
- `src/captions/types.ts`: renderer contracts for settings, backup state, and meeting review.
- `src/captions/ControlApp.tsx`: settings, disclosure, health, recovery/review actions, and labelled log.
- `src/captions/CaptionSurface.tsx`: 3–10 complete entries plus one provisional revision, age opacity, and height reporting.
- `src/captions/captions.css`: readable hierarchy, review card, history transitions, and reduced-motion behavior.
- `vite.config.ts`: package all new main-process modules.
- `docs/windows/README.md`, `docs/windows/implementation-guide.md`, `docs/windows/validation-matrix.md`: report implementation status separately from unrun human validation.

### Task 1: Restore a green W2a baseline

**Files:**
- Modify: `electron/captions/glossary-config.test.cjs`
- Test: `electron/captions/*.test.cjs`

- [ ] **Step 1: Correct the stale migration assertion**

Update the existing legacy-glossary test to assert `settingsVersion === 6`, matching the already-written W2 settings migration.

- [ ] **Step 2: Run the main-process suite**

Run: `npm.cmd run test:captions`

Expected: all current tests pass before integration changes.

### Task 2: Wire W2a through the live session

**Files:**
- Modify: `electron/captions/caption-foundation.test.cjs`
- Modify: `electron/captions/caption-session-manager.js`
- Modify: `electron/captions-main.js`
- Modify: `vite.config.ts`

- [ ] **Step 1: Write failing orchestration tests**

Add tests proving:

```js
await manager.start({ mode: 'live' });
recordController.startSession(/* generated session id and settings */);
manager.appendAudio({ channel: 'microphone', samples, capturedAt: 1234 });
recordController.writeAudioChunk('microphone', samples, 1234, durationMs);
await manager.stop();
recordController.stopSession(/* app version and cost */);
```

Also prove only a final, unsuppressed caption is appended after final normalization has settled.

- [ ] **Step 2: Verify RED**

Run the new focused `node --test` name patterns and confirm the injected controller is not yet called.

- [ ] **Step 3: Implement minimal injection and lifecycle ordering**

Inject `meetingRecordController` and `appVersion` into `CaptionSessionManager`. For live mode only:

- start the record before provider connections;
- tee validated PCM with `capturedAt` and calculated duration;
- append exactly one settled final record;
- stop provider/audio work before flushing/finalizing the record;
- expose the resulting review state in the stop result/snapshot.

Construct the controller in `captions-main.js`, recover pending sessions at startup, broadcast backup/recovery state, destroy the cached key at quit, and add all W2a modules to Vite entries.

- [ ] **Step 4: Verify GREEN**

Run focused tests, full `npm.cmd run test:captions`, and `npm.cmd run build`.

### Task 3: Add narrow record/recovery IPC

**Files:**
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-preload.js`
- Modify: `electron/captions/caption-foundation.test.cjs`
- Modify: `src/captions/types.ts`

- [ ] **Step 1: Write failing sender and contract tests**

Cover choose-directory cancellation, settings update, pending list, Keep, Discard, reveal, transcript-copy export, and untrusted sender rejection.

- [ ] **Step 2: Verify RED**

Run focused tests and confirm the new preload/IPC names do not exist.

- [ ] **Step 3: Implement named operations**

Expose only:

```ts
chooseMeetingRecordsDirectory()
listPendingMeetingRecords()
keepMeetingAudio(sessionId)
discardMeetingAudio(sessionId)
revealMeetingRecord(sessionId)
exportMeetingRecord(sessionId)
onBackupState(callback)
onPendingMeetingRecords(callback)
reportCaptionContentHeight(audience, height)
```

Main-process handlers validate sender, session ID, audience, and finite numeric bounds. No arbitrary filesystem path crosses from renderer to main.

- [ ] **Step 4: Verify GREEN**

Run focused and full main-process tests.

### Task 4: Build the operator workflow and labelled log

**Files:**
- Modify: `src/captions/ControlApp.test.tsx`
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/types.ts`
- Modify: `src/captions/captions.css`

- [ ] **Step 1: Write failing renderer tests**

Test:

- transcript auto-save defaults on;
- automatic audio retention defaults off;
- record controls disable during a session;
- temporary-backup disclosure is persistent and reflects microphone-only/paused/failed states;
- stop produces a Meeting saved review;
- closing/dismissing never discards;
- Keep and explicit-confirmed Discard call their named APIs;
- recovered pending decisions appear before a new session;
- rows label `YOU · MICROPHONE` or `MEETING · SYSTEM AUDIO`, `ORIGINAL`, source language, `ENGLISH VIEW`, and `中文视图`.

- [ ] **Step 2: Verify RED**

Run the focused ControlApp tests and confirm the new settings/review semantics are absent.

- [ ] **Step 3: Implement the minimal UI**

Add the Meeting records settings card, active backup status, post-session/recovery review, and labelled newest-first five-row log. Keep native path/dialog actions behind preload.

- [ ] **Step 4: Verify GREEN**

Run focused and full Vitest suites.

### Task 5: Replace pace with complete-entry history

**Files:**
- Modify: `src/captions/ControlApp.test.tsx`
- Modify: `src/captions/CaptionSurface.test.tsx`
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/CaptionSurface.tsx`
- Modify: `src/captions/types.ts`
- Modify: `src/captions/captions.css`
- Modify: `electron/captions/caption-window-manager.js`
- Modify: `electron/captions/overlay-layout.js`
- Modify: `electron/captions/overlay-layout.test.cjs`
- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-main.js`

- [ ] **Step 1: Write failing renderer and geometry tests**

Prove the 3–10 clamp/default, provisional in-place update, complete-entry count, oldest opacity floor, no pacing delay, numeric height validation, bottom edge preservation, stacked non-overlap, side-by-side bottom alignment, and work-area clamping.

- [ ] **Step 2: Verify RED**

Run focused Node and Vitest tests; failures must identify the fixed-three/pacer behavior.

- [ ] **Step 3: Implement immediate history and measured layout**

Remove `CaptionPresentationPacer` from runtime use and `captionPaceMs` from renderer types/UI. Broadcast audience captions immediately. Retain the newest N completed entries plus the current provisional entry, measure the caption roll with `ResizeObserver`, and coalesce layout updates in main while holding the lower edge fixed.

- [ ] **Step 4: Add reduced-motion styling**

Use short transform/opacity transitions normally and disable movement under `prefers-reduced-motion: reduce`. Keep visible opacity at or above `0.42`.

- [ ] **Step 5: Verify GREEN**

Run focused tests, both full test suites, and the production build.

### Task 6: Bound per-utterance glossary context

**Files:**
- Create: `electron/captions/glossary-request-context.js`
- Create: `electron/captions/glossary-request-context.test.cjs`
- Modify: `electron/captions/caption-session-manager.js`
- Modify: `electron/captions/caption-foundation.test.cjs`
- Modify: `vite.config.ts`

- [ ] **Step 1: Write pure failing compiler tests**

Cover English, Chinese, regional aliases, Latin case-insensitivity, custom-before-built-in ordering, protected-token detection, exact 16-row boundary, exact 800-character boundary, and deterministic metrics.

- [ ] **Step 2: Verify RED**

Run: `node --test electron/captions/glossary-request-context.test.cjs`

Expected: module/function missing.

- [ ] **Step 3: Implement the pure compiler**

Return:

```js
{
  glossary: selectedRows,
  protectedTokens: detectedTokens,
  metrics: { glossaryRows: selectedRows.length, promptCharacters }
}
```

Selection must stop before either bound is exceeded and must not mutate the complete local configuration.

- [ ] **Step 4: Integrate every primary and shadow normalize call**

Compile once per source caption text and pass only the bounded arrays. Add row/character totals to observable normalization metrics while keeping the separately bounded transcription keyword context unchanged.

- [ ] **Step 5: Verify GREEN**

Run focused tests, full main-process tests, and the production build.

### Task 7: Verification and owner-validation handoff

**Files:**
- Modify: `docs/windows/README.md`
- Modify: `docs/windows/implementation-guide.md`
- Modify: `docs/windows/validation-matrix.md`
- Create: `docs/windows/evidence/2026-07-30-w2-working-tree/README.md`

- [ ] **Step 1: Run fresh automated verification**

Run:

```powershell
npm.cmd run test:captions
npx.cmd vitest run
npm.cmd run build
```

Expected: zero failures and the built `dist-electron` contains every W2 module.

- [ ] **Step 2: Perform a package smoke if time permits**

Run `npm.cmd run make` and record artifact paths without claiming install/real-audio validation.

- [ ] **Step 3: Update status honestly**

Mark code/unit/build checks implemented only when verified. Leave real Windows/macOS audio, crash, Keep/Discard playback, DPI/multi-monitor, installed-profile, and soak rows explicitly awaiting the owner.

- [ ] **Step 4: Produce the approval checklist**

The handoff must give the owner a short ordered script:

1. start a real dual-channel meeting;
2. force-close once and verify recovery;
3. Keep one session and play both aligned WAVs;
4. Discard another and verify encrypted sources are gone;
5. exercise 3 and 10 entries in stacked/side-by-side modes at 100/125/150% DPI;
6. inspect labelled saved JSON/Markdown;
7. capture redacted evidence in the W2 evidence directory.

