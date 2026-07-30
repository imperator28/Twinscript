# Meeting Records, Clear Session Log, and Visible History Design

Date: 2026-07-30
Status: Approved for written-spec review
Scope: macOS implementation first, with Windows-compatible data formats and
Electron boundaries

## Decision summary

- Auto-save the session transcript by default.
- Always capture microphone and meeting/system audio into separate encrypted
  temporary tracks.
- Do not retain audio by default.
- When a meeting ends, prompt the user to keep or discard both temporary audio
  tracks.
- Preserve an unanswered audio decision across app restarts and ask again on
  next launch.
- Make the session log explicitly distinguish speaker, original speech, and
  translation.
- Replace Caption pace with Visible history.
- Visible history means 3–10 complete caption entries, default 6.
- Bound the glossary sent to each normalization request by relevance, count,
  and character budget.

This design supersedes the original PRD statement that normal sessions never
write raw audio to disk. Normal sessions now write encrypted temporary audio so
the user can make the retention decision after the meeting. Plain, playable
audio is created only when the user explicitly chooses to keep it.

## Goals

- Make every weekly meeting recoverable without requiring pre-session storage
  decisions.
- Keep microphone and meeting audio independently attributable.
- Ensure a crash or accidental quit does not lose the transcript or silently
  discard an unanswered audio-retention decision.
- Make saved files understandable and portable without the application.
- Make the session log immediately understandable during a live meeting.
- Give audiences enough prior context without slowing transcription delivery.
- Prevent glossary configuration size from quietly multiplying API input-token
  cost.
- Preserve the existing secure Electron boundary: native dialogs and file
  access stay in the main process.

## Non-goals

- Speaker diarization inside the meeting/system track.
- Mixing the two audio tracks into a third file.
- Audio editing, trimming, noise reduction, or playback controls.
- Cloud backup or synchronization.
- Automatic meeting naming from calendar data.
- Recording video, screen content, or the planned virtual-camera output.
- Treating temporary audio capture as hidden behavior.

## User experience

### Before a session

Settings contains a **Meeting records** card:

- **Auto-save transcript** is on by default.
- **Keep audio automatically** is off by default.
- **Save location** shows the current meeting-records folder.
- **Choose folder…** opens a native directory picker.
- Helper text states that microphone and meeting audio are temporarily recorded
  during every live session so the user can decide after the meeting.
- An estimated storage note states that two one-hour, 24 kHz, mono PCM tracks
  can require approximately 346 MB when retained as WAV.

The record settings are disabled while a session is active. The application
does not show a misleading **Record audio** toggle because temporary audio
capture is always active.

### During a session

The control window shows a persistent, non-pulsing status:

```text
TEMPORARY AUDIO BACKUP · MICROPHONE + MEETING
```

The status uses both text and an indicator; color is not the only signal. It
also reports degraded states:

- `MICROPHONE ONLY` when meeting/system capture is unavailable.
- `BACKUP PAUSED · DISK TOO SLOW` when the recorder cannot keep up.
- `BACKUP FAILED · TRANSCRIPT CONTINUES` when recording cannot recover.

Recording failures never stop caption delivery or API streaming. They disable
the unavailable audio choice in the post-session review and explain why.

The transcript is appended after each finalized, unsuppressed caption. The
session can therefore be recovered even if the app or computer exits before a
normal stop.

### After a session

Stopping a meeting replaces the live controls with a **Meeting saved** review
card. The transcript has already been saved. The card reports its folder and
offers:

1. **Keep audio backup** — decrypt and finalize separate playable WAV files
   beside the transcript.
2. **Discard audio** — permanently delete both encrypted temporary tracks. This
   is presented as the recommended privacy choice because retained audio was
   not pre-authorized, but it is never bound to Enter or triggered by closing
   the review card.
3. **Save a copy…** — export the finalized transcript through a native save
   dialog. If audio has already been kept, the user may include both WAV files
   in the copy.
4. **Show in Finder / Show in Explorer** — reveal the meeting folder.

Closing the review card does not imply a destructive choice. If the user does
not choose Keep or Discard, the audio remains encrypted in a pending state and
the application asks again on the next launch. The UI shows the age and size of
pending audio. There is no automatic deletion of unanswered recordings.

When **Keep audio automatically** is enabled, the app finalizes both available
tracks at session end and shows a completion card rather than asking Keep or
Discard. The user can still delete the retained files from the meeting record.

### Relaunch recovery

On launch, the main process scans only the application-owned pending-recordings
directory. For every session without a completed retention decision:

- finalize any recoverable transcript records;
- verify the encrypted audio chunk stream up to its last complete record;
- show a recovery card before the next live session starts;
- allow Keep or Discard using the same actions as the normal post-session
  review.

A partially written final chunk is ignored. Earlier authenticated chunks remain
recoverable.

## Meeting record layout

The user-selected records directory contains one directory per session:

```text
Bilingual Meeting Captions/
└── 2026-07-30 09-30-12/
    ├── transcript.jsonl
    ├── transcript.json
    ├── transcript.md
    ├── session.json
    ├── microphone.wav
    └── meeting-audio.wav
```

`microphone.wav` and `meeting-audio.wav` appear only after Keep audio has
completed. If meeting/system capture was unavailable, the app retains
`microphone.wav` and records the missing channel in `session.json`; it does not
create a misleading silent meeting track.

The app-owned user-data directory holds pending encrypted audio:

```text
pending-meeting-audio/
└── <session-id>/
    ├── microphone.bcr
    ├── meeting-audio.bcr
    └── manifest.json
```

Pending filenames contain no meeting transcript or participant information.

## Transcript formats

### Incremental JSON Lines

`transcript.jsonl` is the crash-safe source of truth. Each line is a finalized
caption record:

```json
{
  "version": 1,
  "sessionId": "session-id",
  "sequence": 14,
  "capturedAt": 1785442212345,
  "sourceChannel": "microphone",
  "sourceLanguage": "en",
  "sourceText": "We will complete T2 next Thursday.",
  "english": "We will complete T2 next Thursday.",
  "chinese": "我们将在下周四完成 T2。",
  "translationStatus": {
    "english": "final",
    "chinese": "final"
  }
}
```

Records are append-only and written with user-only permissions where the
platform supports them. API keys, raw provider messages, and evaluation data
are excluded.

### Final JSON and Markdown

At stop or recovery, the main process reads valid JSONL records and atomically
writes:

- `transcript.json` for structured reuse;
- `transcript.md` for human-readable review;
- `session.json` for timestamps, channel availability, selected glossary
  configuration, model profiles, estimated cost, audio-retention state, and
  application version.

Temporary files are renamed only after a successful flush. Existing finalized
files are never truncated during recovery.

## Audio capture and retention

### Source separation

The renderer already produces independent 24 kHz PCM16 mono buffers for:

- `microphone`;
- `system`.

The IPC payload gains a monotonic capture timestamp. The main process tees each
validated buffer to:

1. the existing transcription session; and
2. the matching encrypted temporary recorder.

The channels never share a file handle or byte stream.

### Synchronization

The manifest records the session clock and the first timestamp received for
each channel. When WAV files are finalized, the exporter inserts leading or
intermediate silence where necessary so both tracks share the same timeline and
duration. This makes them suitable for synchronized review in an editor.

### Temporary encryption

Temporary audio is never stored as plaintext PCM or WAV.

- Each audio chunk is encrypted independently with AES-256-GCM.
- Authenticated metadata includes version, session ID, channel, timestamp, and
  sequence number.
- The installation key is protected by Electron `safeStorage`.
- The decrypted installation key is cached only in main-process memory for the
  current app launch and zeroed at quit.
- The app must not request keychain access once per chunk or once per meeting.
- Temporary files and manifests use user-only permissions when supported.

The implementation may reuse the framing and authenticated-chunk approach from
`EvaluationRecorder`, but meeting backup is a separate component with a
separate directory, manifest schema, and retention lifecycle.

### Write backpressure

Audio persistence uses a bounded asynchronous queue per channel. API streaming
has priority over backup writes.

- A short disk stall buffers a bounded number of chunks.
- When the queue reaches its limit, backup recording enters a degraded state
  and reports dropped backup duration.
- The app never grows an unbounded memory queue.
- Disk failure does not change the audio already sent for transcription.
- The post-session manifest states whether each retained track is complete,
  partial, or unavailable.

### Keep and discard

**Keep** performs this order:

1. validate and decrypt complete authenticated chunks;
2. write each WAV to a sibling `.partial` file;
3. flush and update the WAV header;
4. atomically rename both available tracks;
5. update `session.json` to `audioRetention: "kept"`;
6. delete encrypted temporary tracks.

If one channel fails, the successful channel remains available and the failure
is reported. The process is idempotent after an app restart.

**Discard** performs this order:

1. close and flush temporary writers;
2. delete both encrypted track files and their manifest;
3. update `session.json` to `audioRetention: "discarded"`.

Discard is explicit and irreversible. The confirmation text names both tracks.

## Session log information hierarchy

The current three-column log visually implies that the English column is always
the original. That becomes incorrect whenever a participant speaks Chinese.

Each caption row becomes:

```text
YOU · MICROPHONE
ORIGINAL · ENGLISH
We will finish T2 next Thursday.

TRANSLATION · 中文
我们将在下周四完成 T2。
```

For meeting/system audio, the speaker label is:

```text
MEETING · SYSTEM AUDIO
```

The original field always renders `sourceText`. It never substitutes the
normalized audience output.

The translation field is selected by source language:

- English source → Chinese target.
- Chinese source → English target.
- Mixed source → show `ORIGINAL · MIXED`, then compact `ENGLISH VIEW` and
  `中文视图` target blocks.
- Unknown source → show the original plus both audience targets until the
  language is resolved.

Labels, border treatment, and typography distinguish original from translation.
Color only reinforces the distinction. Translation failure renders an explicit
unavailable state in the affected target block.

The session log remains newest-first and shows the latest five rows during a
live session. The saved transcript contains the entire session.

## Visible history

### Control

The **Caption pace** delay control is removed and replaced with:

```text
Visible history                         6 entries
[────────────●────────────]
3                                      10
Keep complete caption entries visible for audience context.
```

- Setting key: `captionHistoryEntries`.
- Minimum: 3.
- Maximum: 10.
- Default: 6.
- Values are integers.
- Existing settings migrate from `captionPaceMs` to the default history value.
- Caption presentation is immediate; the old delay queue no longer controls
  delivery.

### Overlay behavior

- Each audience overlay retains the newest N complete caption entries.
- A provisional update replaces its existing entry rather than consuming a new
  history slot.
- The newest entry uses full contrast and the strongest type hierarchy.
- Older entries step through bounded opacity levels but never fall below 0.42
  while visible.
- Entries roll upward; they never reorder or flutter.
- Entry movement uses a short transform/opacity transition and no bounce.
- Reduced-motion mode replaces movement with an immediate layout update and a
  short opacity crossfade.

The renderer measures the retained entries after layout and reports a desired
content height through a narrow IPC method. The main process:

- validates the sender and numeric bounds;
- coalesces resize requests;
- keeps the window's bottom edge fixed so growth occurs upward;
- recomputes both windows together in stacked layout so they never overlap;
- bottom-aligns both windows in side-by-side layout;
- clamps the result to the current display work area.

When the selected entries cannot fit within the safe display fraction, the
oldest entry region becomes internally scrollable. The newest caption remains
visible and anchored at the bottom.

## Glossary request budget

The complete selected glossary remains local and available for matching,
transcription setup, import, export, and UI review. The normalizer no longer
sends the complete active glossary with every utterance.

For each source utterance:

1. Match custom and built-in terms against English, Chinese, and regional
   aliases.
2. Include matched custom terms first.
3. Include matched built-in terms next.
4. Fill remaining capacity with high-priority terms from the selected meeting
   configuration.
5. Include only protected tokens detected in the current source text.
6. Stop at either limit:
   - 16 bilingual rows;
   - 800 prompt characters for terminology and protected-token content.

Matching is case-insensitive for Latin text and literal for Chinese text.
Protected tokens are canonicalized locally after output. Final normalization
retains the existing single preservation retry when a detected protected token
is missing.

The transcription session receives one separately bounded keyword list at
session start. Protected tokens come first, followed by high-priority terms and
aliases, up to the provider limit. This one-time recognition context is not
expanded per utterance.

Usage metrics record the selected glossary row count and prompt-character count
per normalization request so later cost regressions are attributable. Prompt
caching is an optimization, not a correctness or budget dependency.

## Component boundaries

### Renderer

- Captures timestamped PCM buffers.
- Displays backup status and post-session decisions.
- Displays labelled original and translation blocks.
- Measures overlay content height.
- Sends user intent through narrow preload methods.
- Never receives encryption keys or unrestricted file paths.

### Preload

Exposes typed methods for:

- choosing the meeting-records directory;
- reading record preferences and backup status;
- keeping or discarding pending audio;
- exporting or revealing a meeting record;
- reporting validated overlay content height.

Raw `ipcRenderer`, filesystem primitives, and arbitrary paths are not exposed.

### Main process

- Owns settings, native dialogs, path validation, and record directories.
- Appends finalized transcript records.
- Encrypts and queues temporary audio.
- Finalizes or discards audio after user intent.
- Recovers pending sessions.
- Resizes caption windows while preserving display bounds.
- Broadcasts backup and recovery state to the control window.

### Session manager

- Emits finalized caption records to the transcript recorder.
- Forwards validated audio buffers to transcription and backup sinks.
- Does not perform direct filesystem writes.
- Does not block live transcription on backup persistence.

## Settings and migration

The next settings schema adds:

```json
{
  "autoSaveTranscript": true,
  "keepAudioAutomatically": false,
  "meetingRecordsDirectory": null,
  "captionHistoryEntries": 6
}
```

`meetingRecordsDirectory: null` resolves in the main process to:

```text
<Documents>/Bilingual Meeting Captions
```

Migration removes the behavioral effect of `captionPaceMs`. The old value may
be ignored after migration; it must not delay captions.

## Failure and edge cases

- **No meeting/system audio permission:** record microphone only and state the
  missing track in the manifest and review card.
- **No microphone permission:** the live session cannot start; no record
  directory is created.
- **Transcript folder unavailable:** show a blocking readiness error before
  starting because transcript auto-save is part of the default contract.
- **Insufficient disk space:** warn before start when detectable; during the
  meeting, degrade backup without stopping captions.
- **App crash:** recover complete transcript lines and authenticated audio
  chunks at relaunch.
- **Power loss during WAV finalization:** retain encrypted inputs and retry;
  never delete them until every requested retained track is finalized.
- **Repeated Keep/Discard command:** return the existing terminal state without
  duplicating files or reporting a false error.
- **Path removed after selection:** fall back only after explicit notification;
  do not silently save to a different folder.
- **Session stopped with no captions:** save the session manifest and offer the
  same audio decision.
- **Mock/demo session:** save neither transcript nor audio unless an explicit
  developer fixture requests it.

## Testing

### Unit tests

- Transcript JSONL appends only finalized, unsuppressed captions.
- Atomic finalization survives truncated final JSONL lines.
- Microphone and system audio write to separate authenticated streams.
- Audio timestamps produce aligned WAV output.
- Keep and Discard are idempotent.
- A failed channel does not corrupt the successful channel.
- Key material is loaded once per app launch and zeroed at shutdown.
- Backup queue bounds memory and reports dropped backup duration.
- Glossary selection honors custom priority, term count, character count, and
  detected protected tokens.
- Settings migrate to transcript auto-save on, automatic audio retention off,
  and six visible entries.

### Renderer tests

- Session rows label original and translation correctly for English, Chinese,
  mixed, and failed results.
- Color is not the only distinction.
- Live backup state names both tracks.
- Post-session review exposes Keep, Discard, Save a copy, and reveal actions.
- Visible-history control accepts only 3–10 complete entries.
- Reduced motion removes positional animation.

### Electron integration tests

- Untrusted renderers cannot choose paths, keep/discard recordings, or resize
  caption windows.
- Overlay height remains bottom-anchored in stacked and side-by-side layouts.
- Native dialogs return only validated record-directory operations.
- Crash recovery finds only application-owned pending manifests.
- A 60-minute two-channel synthetic recording finalizes playable, aligned WAV
  files without unbounded memory growth.

### Manual acceptance

1. Run a bilingual meeting with microphone and system audio.
2. Confirm immediate captions and six-entry audience history.
3. Confirm the overlay grows upward and remains inside the display work area.
4. Confirm the session log labels the original and translated text correctly
   when switching languages.
5. Stop the session and choose Keep audio.
6. Play both WAV files independently and confirm microphone speech and meeting
   playback are separated and synchronized.
7. Repeat and choose Discard; confirm no playable or pending audio remains.
8. Force-quit during a session, relaunch, and recover or discard the pending
   tracks.
9. Confirm no repeated keychain prompt occurs during chunk recording, stopping,
   keeping, or discarding.
10. Inspect normalization metrics and confirm no request exceeds 16 glossary
    rows or 800 glossary prompt characters.

## Security and privacy review

- The application visibly discloses that temporary recording is always active.
- Temporary audio is encrypted before being written to disk.
- Audio retention requires an explicit post-meeting choice unless automatic
  retention was deliberately enabled.
- Declining retention removes both channel files and records the decision.
- Transcript auto-save is explicit in Settings and can be disabled.
- Exports never include API credentials, encryption keys, raw provider events,
  or unrelated evaluation data.
- The renderer cannot read arbitrary local files or choose arbitrary write
  paths through IPC payloads.
- No additional audio is sent to OpenAI because of local backup recording.

## Design review

| Before | After | Why |
| --- | --- | --- |
| Manual transcript export only | Incremental auto-save plus post-meeting export | Prevents accidental meeting loss |
| No normal-session audio backup | Encrypted temporary dual-track capture with post-meeting retention choice | Allows a decision after the meeting without hidden plaintext recording |
| English and Chinese columns without provenance labels | Speaker, Original, and Translation labels | Makes source versus generated text unmistakable |
| Caption delay slider | Visible-history entry slider | Matches the audience's need for prior context |
| Fixed three-entry overlay | 3–10 complete entries with bottom-anchored growth | Preserves context while keeping spatial behavior predictable |
| Full glossary repeated per normalization request | Context-selected bounded glossary payload | Controls input-token cost without weakening the reusable local glossary |
