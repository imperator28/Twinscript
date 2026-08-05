# Windows validation matrix

Use one report per build. Store reports under
`docs/windows/evidence/YYYY-MM-DD-build-<commit>/` only after removing API keys,
private meeting content, personal names, and vendor-confidential information.
Do not commit raw audio or real transcripts.

## Report header

```text
Commit:
Build type: development | unsigned installer | signed installer
Windows edition/version/build:
Architecture:
Display scaling and monitor layout:
Microphone:
Playback device:
Meeting client and version:
OBS version, if used:
OpenAI model/profile:
Glossary configuration:
Tester:
Date/time/timezone:
```

For each row, record `PASS`, `FAIL`, or `NOT RUN`, plus a short observation and
the non-sensitive evidence filename.

## W0 — build, package, and install

| Check | Pass condition |
| --- | --- |
| Clean dependency install | `npm ci` exits 0 in the documented Windows shell without manually skipping post-install work. |
| Caption tests | `npm run test:captions` exits 0. |
| Component/unit tests | `npx vitest run` exits 0. |
| Production build | `npm run build` exits 0. |
| Development launch | `npm run dev` launches the Electron control client. |
| Forge make | `npm run make` emits Setup EXE, NUPKG, and RELEASES for x64. |
| Fresh install | Setup installs for a standard user and launches one control window. |
| Squirrel events | Install/update/uninstall events do not create an ordinary duplicate app window. |
| Taskbar lifecycle | Control window appears in the taskbar; caption windows do not. |
| Exit | Closing the control window ends the app and releases microphone/system capture. |
| Credential safety | A saved key survives restart, is not in settings/logs, and causes no repeated prompt. |
| Secret scan | `git grep` and the packaged resources contain no real API key. |

W0 fails if installation works only from an elevated developer shell or if a
real API key is required to build.

Recorded runs:

- [2026-07-30, working tree on `4a3f7be2`](evidence/2026-07-30-w0-working-tree/README.md)
  — build, tests, dev launch, package, fresh install, Squirrel events, exit,
  uninstall, and secret scan PASS. Outstanding: a visual taskbar check, the
  API-key round trip, and the secure-storage recovery action.

## W1 — real meeting parity

### Input and lifecycle

| Check | Pass condition |
| --- | --- |
| Microphone permission | The app requests access once and shows a moving meter for the selected device. |
| Device change | Selecting another microphone changes the actual captured source. |
| Windows loopback | Playback from the chosen meeting client moves the meeting/system meter. |
| Separate attribution | Local speech is `YOU`; playback is `MEETING`; obvious duplicates are suppressed. |
| Start | State moves `ready → starting → running` once without jitter. |
| Stop | **Stop Session** remains visible during running, degraded, and reconnecting states and ends capture. |
| Degraded loopback | Microphone captions continue with a clear warning if system capture fails. |
| Reconnect | A short network interruption does not create a second session or lose the stop control. |
| Headphone echo | Meeting playback is not duplicated through microphone capture under the recommended setup. |

### Language behavior

Use at least 20 utterances per scenario.

| Scenario | Pass condition |
| --- | --- |
| English microphone | English surface is fluent English; Chinese surface is fluent Simplified Chinese. |
| Chinese microphone | English surface is fluent English; Chinese surface is fluent Simplified Chinese. |
| English meeting playback | Both surfaces show the correct audience language and `MEETING`. |
| Chinese meeting playback | Both surfaces show the correct audience language and `MEETING`. |
| Between-turn switching | Alternating English and Chinese never strands an entry in the wrong audience language. |
| Inline switching | Mixed terms such as “T2 治具 tolerance stack-up” remain intelligible in both outputs. |
| Numbers and units | Part numbers, dimensions, tolerances, currency, dates, and quantities retain their values. |
| Protected tokens | `T1`, `T2`, `EVT`, `DVT`, `PVT`, `MP`, `NPI`, `BOM`, and `ECO` are not translated. |
| Regional glossary | South China shop-floor aliases from the universal engineering glossary normalize consistently without flooding the prompt. |

Suggested release threshold for the scripted bilingual corpus:

- wrong-audience-language rate: 0%;
- critical number/unit/part-ID error rate: less than 1%;
- protected-token preservation: 100%;
- duplicate visible-entry rate: less than 1%;
- median finalized-source-to-both-audiences latency: at most 2.5 seconds;
- p95 finalized-source-to-both-audiences latency: at most 5 seconds; and
- dropped audio: less than 0.5% of captured duration on each channel.

These thresholds are product gates, not claims about current measured
performance.

#### Automated coverage

Four of those seven thresholds are measured by a repeatable run:

```bash
npm run w1:corpus -- --out docs/windows/evidence/w1-corpus.json
```

It drives all 256 scripted corpus prompts through the real normalizer and the
real glossary compiler for both audiences, then writes a JSON and a Markdown
report and exits non-zero if any gate fails. It covers wrong-audience-language
rate, protected-token preservation, critical value error rate, and normalizer
latency. It needs `OPENAI_API_KEY` in the environment or `.env.local`.

It does **not** cover ASR accuracy, dropped audio, duplicate visible-entry
rate, or true spoken-word-to-overlay latency — its latency figure is normalizer
round-trip only. Those four still require the manual soak below, so a green run
is a necessary but not sufficient condition for W1.

Two offline modes need no key and no tokens:

```bash
npm run w1:corpus:check
```

validates corpus shape and glossary budgets, and scores each prompt's own
reference answer with the same detectors — catching cases where a perfect
translation would still be marked a defect. `--mock` additionally replays the
whole pipeline offline; a `--mock` run that fails a gate indicates a bug in the
runner rather than in the product.

One known corpus/detector disagreement is reported by `w1:corpus:check`:
`tool-revision-1-en` renders "Tool 3" as 三号模具, which the protected-token
check scores as losing the literal `3`. Until that is settled in the corpus or
the detector, protected-token preservation tops out at 99.61%.

### Windows overlay

| Check | Pass condition |
| --- | --- |
| Close/restore | Either close control hides both overlays; **Show captions** restores them. |
| Drag | The visible top handle moves each window reliably. |
| Synchronized resize | Drag the height of either English or Chinese. The peer follows live, both remain equal, and neither snaps back as captions arrive. |
| Resize persistence | A manually chosen height survives Stop/Start and full app restart. |
| History preserves manual floor | Changing Visible history keeps a manually dragged height as the minimum; the equal pair grows above that floor when required and never automatically shrinks below it. |
| Stacked | Windows remain separate, ordered, and inside the work area. |
| Side by side | Both windows are visibly side by side on a wide display. |
| Balanced caps | The stacked pair blocks no more than about 45% of the work area; side-by-side panels block no more than about 33%. Overflow scrolls. |
| DPI | Layout is usable at 100%, 125%, and 150%. |
| Multi-monitor | Moving between primary/secondary monitors preserves anchoring and visibility. |
| Always on top | Captions remain above the chosen meeting/shared-screen workflow. |
| Control taskbar | Control window remains discoverable through the taskbar. |
| Reduced motion | History changes remain clear with Windows animation reduction enabled. |

## W2 — records, retention, and visible history

Automated readiness was rechecked on 2026-07-30 in
[`evidence/2026-07-30-w2-working-tree/README.md`](evidence/2026-07-30-w2-working-tree/README.md).
Those checks prove unit/integration behavior, renderer contracts, production
bundling, and unsigned packaging. They do not satisfy the real-device pass
conditions below; complete those checks before marking W2 passed.

### Transcript and attribution

| Check | Pass condition |
| --- | --- |
| Default | Transcript auto-save is on for a new install. |
| Final-only rows | Provisional revisions do not become duplicate saved entries. |
| Attribution | Every row records microphone/system and labels `YOU`/`MEETING`. |
| Audience columns | Original, English audience, and Chinese audience values are explicitly labeled. |
| Stop finalization | JSONL recovery source finalizes into valid JSON and Markdown. |
| Crash recovery | Complete rows survive forced termination and are offered on restart. |

### Temporary and retained audio

| Check | Pass condition |
| --- | --- |
| Always active | A real session starts two encrypted temporary writers when both channels are available. |
| No plaintext pending | No PCM or WAV exists before the user chooses Keep. |
| Channel separation | Microphone and meeting audio are stored in distinct authenticated streams. |
| Keep | The review creates aligned, playable `microphone.wav` and `meeting-audio.wav`. |
| Discard | Both pending streams are permanently removed and the manifest records the decision. |
| Decision later | Closing the review preserves encrypted pending audio and asks again after restart. |
| Partial channel | A missing meeting channel produces one microphone WAV and an explicit manifest state. |
| Disk failure | Transcription continues; backup status becomes visible and accurate. |
| Repeated restart | Recovery is idempotent and does not create duplicate WAVs or transcript rows. |
| No extra API use | Local backup does not add OpenAI audio duration or normalization calls. |

### Visible history

| Check | Pass condition |
| --- | --- |
| Bounds | Setting accepts 3–10 complete entries and clamps all other values. |
| Default | A new or migrated install uses 6 entries. |
| Completeness | The count refers to completed entries, not wrapped text lines. |
| Provisional update | Current speech revises in place and does not consume multiple history slots. |
| Translation-lag focus | If either audience translation is still processing, the row remains prominent in both panels even if the other audience text is final. |
| Multiple in-flight rows | Several simultaneously translating rows remain full-size/full-opacity together. |
| Settled focus | The two newest fully settled rows remain prominent; only older settled rows become compact history. |
| Upward growth | Lower edge remains fixed while added history moves the top edge upward. |
| Readability | Older retained entries remain readable with age-based opacity. |
| No pace delay | Setting history to 10 does not delay transcription or translation. |
| Layout modes | Stacked and side-by-side remain in the display work area at maximum history. |

### Projection behavior â€” Windows and macOS manual sequence

Run the following on Windows, then repeat on actual macOS hardware. On macOS,
use the Bilingual Camera Stage preview or OBS capture path; the native Windows
camera installation action is intentionally unavailable.

1. Start an on-screen-caption session and drag either audience overlay to a
   clearly taller manual height. Confirm the peer follows and both panels stay
   equal.
2. Set Visible history to 3, then 10, then 3. At 10, confirm the pair can grow
   upward from its bottom edge to fit the additional entries. After returning to
   3, confirm it does not automatically shrink below the manually selected
   height; explicitly drag smaller to confirm that manual resize is respected.
3. In the audience preview, choose Stacked, then Side by side. Hide the preview,
   press Escape to close its stage window, and reopen it. Confirm each layout
   fills the video frame with the selected arrangement and remains readable.
4. Select Virtual camera. Confirm the Stacked and Side by side controls remain
   visible and usable, the selected state follows the saved setting, and
   on-screen overlays remain hidden while the Camera Stage is previewed. Switch
   back to On-screen captions and confirm the active session continues.

Record the drag height, history values, layout, output mode, and whether the
bottom edge stayed anchored. PASS requires equal panels, automatic growth above
the manual floor, no automatic shrink below it, and full-frame Camera Stage
layouts on both platforms.

### Session boundary and caption themes

| Check | Pass condition |
| --- | --- |
| Fresh start | Stop a session, then Start Session. Both overlays are empty/Listening before new speech; no prior row overlaps the new conversation. |
| Saved records | Starting fresh does not remove the prior transcript or meeting record. |
| Theme choices | Blueprint, Graphite, and Red / Blue each update both visible panels immediately; Red / Blue maps English to blue and Chinese to red. |
| Theme persistence | The selected paired theme survives app restart. |
| Pair clarity | English and Chinese surfaces remain visually distinct, labels remain explicit, and text is readable over bright and dark underlying apps. |
| Default | A new or migrated install selects Blueprint. |

### Glossary request budget

| Check | Pass condition |
| --- | --- |
| Universal library | The settings card has no meeting-type selector and reports the complete universal built-in glossary. |
| Custom preservation | Imported terms, custom overrides, and additional protected tokens survive restart and take priority over built-ins. |
| Matched context | Normalization receives relevant custom, built-in, and regional-alias rows first. |
| Row bound | No normalization request receives more than 16 glossary rows. |
| Character bound | Terminology and protected-token prompt content never exceeds 800 characters. |
| Protected-token filtering | Only tokens detected in the current source are included in that request. |
| Usage evidence | Metrics record selected glossary rows and prompt characters per request. |

## W3 — OBS virtual camera

**Direct evidence captured 2026-07-30 and 2026-07-31:** the packaged app exposes a dedicated
1920×1080 stage; official OBS Studio 32.1.2 from GitHub captures
`Bilingual Camera Stage` into a 1920×1080/30 fps `Bilingual Captions` scene
without chrome, clipping, transparency, or private state. See
[the W3 working-tree evidence](evidence/2026-07-30-w3-working-tree/README.md).
System installation, both virtual-camera registrations, authenticated virtual
camera startup, and Chrome enumeration/format negotiation are directly
observed. Chrome visual rendering and every remaining meeting-client row below
remain unpassed until directly observed.

| Check | Pass condition |
| --- | --- |
| Stage | App opens a clean, capturable 1920×1080 16:9 bilingual stage. |
| Split | English is upper half; Chinese is lower half; both show the same meeting sequence. |
| Privacy | Feed excludes controls, credentials, cost, notifications, and private app chrome. |
| OBS capture | Window Capture fills the canvas without clipping or unintended transparency. |
| Meeting enumeration | Teams, Zoom, and a Chromium meeting client list OBS Virtual Camera. **Confirmed 2026-08-02 in Microsoft Teams and Chromium (Chrome/Edge/Meet); Zoom still outstanding.** |
| Readability | Remote attendee can read both halves in normal meeting layouts. |
| History | Changing 3–10 entries updates both halves without reconnecting. |
| Mode switch | Overlay ↔ virtual camera switch does not stop the caption session. |
| 60-minute soak | No frozen/black frame, runaway memory, or lost caption channel. |

## W4 — native Windows 11 camera

> **SUPERSEDED 2026-08-05 — the native camera works, via DirectShow.**
>
> The Media Foundation approach below was abandoned after five failed attempts and
> replaced by a DirectShow capture filter, which streams the live caption stage in
> Microsoft Teams. See `## W6 — DirectShow virtual camera` at the end of this file.
> The rest of this section is retained for the record.

**Blank feed: STILL BROKEN (2026-08-03).** Teams lists and selects
**Twinscript (Windows Virtual Camera)** and the feed is blank. Enumeration works;
frame delivery does not.

`IMFSampleAllocatorControl` was implemented and is **not** the cause. The source
log proves the Frame Server has never instantiated our media source at all — every
one of the 395 loads is our own `vcam-host.exe` or the probe harness, zero are
`svchost`/`frameserver`, and `NT AUTHORITY\LOCAL SERVICE` has Modify on the log
directory so a Frame Server load would have been recorded. Every run stops at the
same place: `ActivateObject` succeeds, three IIDs are refused, nothing follows —
no allocator handshake, no `Start`, no `RequestSample`.

Both our source and Microsoft's reference refuse the same three IIDs, and the
reference streams, so the divergence is **before** source-interface negotiation.
The `{2032C7EF-…}` refusal is not the cause either.

Next candidate: `MF_DEVICEMFT_SENSORPROFILE_COLLECTION`, which the reference
publishes and we do not. See `evidence/2026-08-02-w4-reference-control/`.

| Check | Pass condition |
| --- | --- |
| Frame Server streaming | **FAIL.** Camera enumerates in Teams; feed is blank. The Frame Server never instantiates the source. |
| Consumer timeout | **Gap.** `ConsumeCamera` calls `ReadSample` synchronously with no bound, so "no frames" hangs silently instead of failing. This is why a run could be mistaken for a possible success. |
| Allocator handshake | **Automated pass.** Six source-contract invariants pin the interface, `UsesProvidedAllocator`, allocation from the provided allocator only, loud failure when none is supplied, rebinding on NV12↔RGB32 renegotiation, and the in-process harness performing the handshake instead of bypassing it. |
| OS gate | **Automated pass.** Native actions are limited to Windows Build 22000+ x64; unsupported systems retain the OBS path. Manual Windows 10 visual confirmation remains. |
| Registration | **Implemented; manual pending.** Install/Repair/Remove use one verified ProgramData target and the stable CLSID. `bin` remains Administrator/SYSTEM-owned; only the dedicated runtime/log directories are user-writable. Approve UAC and verify install/update/repair/uninstall on the test profile. |
| Enumeration | **Manual pending.** Teams, Zoom, and Chromium must list and render the newly installed camera. |
| Format | **Automated transport/source pass; manual display pending.** Full-size 1920×1080 BGRA crosses Node→C++; the source offers NV12 and RGB32 at 15 fps. Confirm undistorted meeting-client display. |
| Frame stall | **Automated pass.** Reader tests cover fresh, repeat, two-second expiry, idle, stopped, malformed, and neutral-slate substitution. |
| Crash isolation | **Automated supervisor pass; manual live-session pending.** No transcription callback is coupled to camera failure. Kill the real companion during a live session. |
| Recovery | **Automated supervisor-contract pass; real-process manual pending.** Exit and spawn-error paths clear ownership, allow exactly one restart, and require manual Retry after the second failure. Kill the installed process to confirm the real feed. |
| Mode switch | **Automated lifecycle pass; manual live-session pending.** Start/stop is serialized, rapid races are rejected, 50 accelerated mode cycles leave no offscreen renderer/companion alive, and Preview/Hide preview remains independent. |
| Version drift | **Automated pass; update manual pending.** Installed host/DLL bytes are compared with packaged resources and surface Repair required before launch when they differ. Confirm the state across an actual app update. |
| Standard user | **Manual pending.** Installed camera must operate without repeated elevation after the one-time explicit install. |
| 60-minute soak | **Manual pending.** No registration loss, black/frozen frame, runaway memory, or unrecoverable companion failure. |
| Windows 10 | **Automated gate pass; manual visual pending.** App offers OBS and does not expose an installable native action. |

## W5 — signed release

**Decision (2026-08-02): internal distribution, unsigned.** The release workflow
runs on `RELEASE_CHANNEL: internal` and publishes unsigned builds as labelled
prereleases. Signing is not required for internal use — the Frame Server loads
our unsigned DLL, Squirrel does not verify signatures on update, and install is
per-user. See `docs/windows/signing.md`.

Two environment checks replace the signing rows for internal rollout, and both
are hard blockers with no workaround from our side:

| Check | Pass condition |
| --- | --- |
| Smart App Control | `SmartAppControlState` is `Off` or `Eval` on every target machine. `On` blocks unsigned installers with no override. |
| WDAC / AppLocker | No enforced code-integrity policy on target machines. Confirm with IT. |

The signing rows below stay in the matrix for a future public release.

| Check | Pass condition |
| --- | --- |
| Repository workflow | Signing job runs for `imperator28/bilingualmeetingcaption`, not only upstream Sokuji. **Resolved by `windows-release.yml`.** `build.yml` cannot release here at all: its `sign-windows` job is gated on the upstream repository, `release` needs that job, and a skipped dependency skips its dependents — so tagging produces no release through `build.yml`. |
| Tag/version agreement | **Automated.** `node scripts/verify-tag-version.mjs "$GITHUB_REF"` fails the release if the tag and the built version disagree. Root `package.json` and `package-lock.json` only — the extension is a separate upstream product at an unrelated version and is deliberately excluded. |
| Secret handling | Signing material exists only in the protected CI environment. **Workflow reads provider credentials from a `windows-signing` GitHub environment; nothing is in repository secrets.** Pending real credentials. |
| Signature coverage | Installer, app EXE, camera companion, and registration components verify successfully. **Automated** by `npm run verify:signatures`; fails on an empty scan, missing installer, unmapped status, tampering, untrusted root, or unexpected signer. Pending real signatures. |
| Signing order | **Sign before packaging.** `electron-forge make` seals the app EXE and both native camera binaries inside the `.nupkg`; signing only the finished `*Setup*.exe` — what the inherited `build.yml` job does — leaves them unsigned. Use `maker-squirrel`'s `windowsSign`. |
| Clean install | Signed setup installs for a standard user on a clean Windows profile. **Manual** — needs a clean profile. |
| Upgrade | Installing the next signed version preserves settings and meeting records. **Manual** — needs two signed versions. |
| Uninstall | App and native camera are removed; user meeting records are handled according to the stated policy. **Manual.** |
| SmartScreen | Release behavior is documented; no unexpected unsigned-child warning occurs. **Manual.** Record the observed behaviour even if it warns: an OV certificate has no reputation on day one. |
| Release assets | Published EXE/NUPKG metadata matches the signed files. **Partly automated** — the release job publishes only what the verified build produced, and refuses to publish at all when signing is unconfigured. |
| Launch/exit | **Automated.** `npm run smoke:packaged` requires the packaged app to launch, survive startup, and exit completely on window close. Needs an interactive desktop session on the runner. |

## 60-minute soak script

Use a consent-safe scripted session:

1. 10 minutes English microphone and Chinese meeting playback.
2. 10 minutes Chinese microphone and English meeting playback.
3. 10 minutes between-turn and inline code-switching with engineering terms.
4. 5 minutes silence and background noise.
5. 5 minutes network interruption and recovery.
6. 5 minutes microphone device change.
7. 5 minutes output-mode and layout changes.
8. 10 minutes normal conversation at a fast speaking rate.

At the end:

- stop from a degraded or healthy state;
- inspect transcript attribution;
- keep one run's audio and verify both channels;
- discard a second run and verify deletion;
- inspect peak memory/CPU/GPU;
- confirm API cost against captured duration and token counts; and
- restart the app to confirm no unresolved state or repeated credential prompt.

## Evidence hygiene

Acceptable committed evidence:

- redacted screenshots;
- test command output with paths/usernames removed;
- version and device metadata;
- aggregate latency/error counters;
- a synthetic transcript fixture; and
- a checklist with observations.

Never commit:

- an OpenAI API key;
- `openai.enc`;
- raw or retained meeting audio;
- a real meeting transcript;
- vendor names, part numbers, drawings, or commercial information;
- an unredacted Electron `userData` archive; or
- signing certificates/tokens.

## W6 — DirectShow virtual camera

**Working as of 2026-08-05.** The live bilingual caption stage renders in Microsoft
Teams through our own camera, selected as **Twinscript** in the camera picker.

This replaces the Media Foundation attempt in W4, which enumerated everywhere and
streamed to an in-process consumer but produced a black feed in every meeting
client. Five changes to that source failed; the differential trace against
Microsoft's reference camera showed an identical call sequence and identical
interfaces, and showed that the instance which actually delivers frames is not
observable from either side. DirectShow has no such opacity, and it was already
proven on the target hardware — OBS Virtual Camera is a DirectShow filter.

Clean-room implementation informed by OBS's architecture. OBS is GPL-2.0 and none
of its code is used.

### Why DirectShow succeeded where Media Foundation did not

The decisive difference is observability. A DirectShow filter is loaded **directly
into the consumer process**, so `ms-teams.exe`, `Slack.exe` and `chrome.exe` all
appear in our own log with the interfaces they asked for and the HRESULTs they got.
Across five Media Foundation sessions a consumer process never appeared once.

| Check | Pass condition |
| --- | --- |
| Registration | **Pass.** Both halves land — COM in-proc server plus the device-category entry via `IFilterMapper2`. Verified structurally identical to the working OBS filter: CLSID-named instance key, 88-byte `FilterData`. A failed category registration rolls the COM key back, so the half-registered "enumerates then fails to activate" state cannot occur. |
| Enumeration | **Pass.** Listed as `Twinscript` in Teams, Slack and Chrome. |
| Streaming | **Pass.** Cycling synthetic colour confirmed continuous delivery before the real source was wired in; the live stage renders now. |
| Frame source | **Pass.** Reuses the W4.1 shared-memory transport unchanged (`MappedFrameReader`, `frame_transport.h`). BGRA8 top-down is byte-identical to the advertised RGB32 negative-height type, so nothing converts. |
| AppContainer access | **Pass.** Teams is a packaged MSIX app in an AppContainer, so both the filter DLL **and** the frame region need `ALL APPLICATION PACKAGES` read. Install grants both; `Status` reports them. Missing either produces a silent slate or a load failure. |
| Install collision | **Pass.** Each install stages under a timestamped filename. The filter is loaded by every process that merely enumerates cameras, so overwriting one canonical path fails with a sharing violation and "close every app that listed a camera" is not actionable. |
| Zoom | **Manual pending.** Not yet checked. |
| 60-minute soak | **Manual pending.** No frozen frame, runaway memory, or lost camera. |
| Standard user | **Manual pending.** Install needs elevation once (`IFilterMapper2` writes under `HKEY_CLASSES_ROOT`); ordinary sessions must not. |
| 32-bit consumers | **Not built.** OBS ships a 32-bit filter alongside its 64-bit one, so 32-bit clients exist in practice. Teams and Chrome here are x64. A 32-bit build is required before claiming general client support. |

Install, remove, and inspect with `scripts/register-dshow-camera.ps1`.

### W6.4 — retiring the Media Foundation path

**Partially done.** The DirectShow filter is the shipping camera and is packaged
into the installer. The Media Foundation source is still present and still
packaged, because the app's own camera lifecycle is wired to it.

Done:

- `twinscript-dshow-camera.dll` and `register-dshow-camera.ps1` are staged into
  `resources/native-camera`, asserted by both Windows workflows.
- `vcam-host drive` and `vcam-host selftest` **refuse to run**. They activated the
  media source in-process, bypassing the Frame Server entirely, and reported
  success for weeks while every meeting client showed black. Five source changes
  were made on the strength of them. They now print what to use instead. The
  implementations remain reachable as `drive-legacy` and `selftest-legacy` for
  deliberate use while the MF source is still in the tree.

Not done, and why it is not a deletion:

The app's camera output calls `nativeCameraSupervisor`, which spawns and
health-monitors `vcam-host.exe serve` as the process that owns the camera's
lifetime. **DirectShow has no such process** — the filter is loaded directly into
the consumer. So retiring MF means re-architecting the camera lifecycle, not
removing files:

| Change | Why it is not trivial |
| --- | --- |
| Replace `native-camera-supervisor.js` (350 lines) | Health becomes "is the filter registered?" rather than "is the companion alive?" |
| Repoint `native-camera-installer.js` | Install becomes an elevated `regsvr32` of the filter plus the two AppContainer ACEs, not a file copy plus HKLM CLSID write |
| Rework the camera health IPC and the control-panel panel | Retry/Repair/Remove and the FAILED state all assume a crashing companion process |
| Then drop `vcam_source`, `vcam_host serve`, and the MF scripts | Only safe once nothing calls them |

Doing this out of order breaks a camera that currently works, so it is sequenced
deliberately rather than rushed.
