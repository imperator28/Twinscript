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
| Regional glossary | Selected South China shop-floor terms normalize consistently without flooding the prompt. |

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

### Windows overlay

| Check | Pass condition |
| --- | --- |
| Close/restore | Either close control hides both overlays; **Show captions** restores them. |
| Drag | The visible top handle moves each window reliably. |
| Resize | User resize works without breaking text layout. |
| Stacked | Windows remain separate, ordered, and inside the work area. |
| Side by side | Both windows are visibly side by side on a wide display. |
| DPI | Layout is usable at 100%, 125%, and 150%. |
| Multi-monitor | Moving between primary/secondary monitors preserves anchoring and visibility. |
| Always on top | Captions remain above the chosen meeting/shared-screen workflow. |
| Control taskbar | Control window remains discoverable through the taskbar. |
| Reduced motion | History changes remain clear with Windows animation reduction enabled. |

## W2 — records, retention, and visible history

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
| Upward growth | Lower edge remains fixed while added history moves the top edge upward. |
| Readability | Older retained entries remain readable with age-based opacity. |
| No pace delay | Setting history to 10 does not delay transcription or translation. |
| Layout modes | Stacked and side-by-side remain in the display work area at maximum history. |

### Glossary request budget

| Check | Pass condition |
| --- | --- |
| Local library | Complete selected/imported glossary remains available to the UI and matching code. |
| Matched context | Normalization receives relevant custom, built-in, and regional-alias rows first. |
| Row bound | No normalization request receives more than 16 glossary rows. |
| Character bound | Terminology and protected-token prompt content never exceeds 800 characters. |
| Protected-token filtering | Only tokens detected in the current source are included in that request. |
| Usage evidence | Metrics record selected glossary rows and prompt characters per request. |

## W3 — OBS virtual camera

| Check | Pass condition |
| --- | --- |
| Stage | App opens a clean, capturable 1920×1080 16:9 bilingual stage. |
| Split | English is upper half; Chinese is lower half; both show the same meeting sequence. |
| Privacy | Feed excludes controls, credentials, cost, notifications, and private app chrome. |
| OBS capture | Window Capture fills the canvas without clipping or unintended transparency. |
| Meeting enumeration | Teams, Zoom, and a Chromium meeting client list OBS Virtual Camera. |
| Readability | Remote attendee can read both halves in normal meeting layouts. |
| History | Changing 3–10 entries updates both halves without reconnecting. |
| Mode switch | Overlay ↔ virtual camera switch does not stop the caption session. |
| 60-minute soak | No frozen/black frame, runaway memory, or lost caption channel. |

## W4 — native Windows 11 camera

| Check | Pass condition |
| --- | --- |
| OS gate | Native option appears only on Windows Build 22000 or newer. |
| Registration | Install registers one stable camera identity; uninstall removes it. |
| Enumeration | Teams, Zoom, and Chromium list and render the camera. |
| Format | 1920×1080 at 15 or 30 fps negotiates without distortion. |
| Frame stall | Latest frame repeats briefly, then a neutral slate appears. |
| Crash isolation | Killing the companion does not stop transcription. |
| Recovery | One automatic companion restart restores the feed. |
| Mode switch | Native camera starts/stops without restarting the caption session. |
| Standard user | Installed camera operates without repeated elevation. |
| 60-minute soak | No registration loss, black frame, or unrecoverable companion failure. |
| Windows 10 | App offers OBS and does not show a broken native action. |

## W5 — signed release

| Check | Pass condition |
| --- | --- |
| Repository workflow | Signing job runs for `imperator28/bilingualmeetingcaption`, not only upstream Sokuji. |
| Secret handling | Signing material exists only in the protected CI environment. |
| Signature coverage | Installer, app EXE, camera companion, and registration components verify successfully. |
| Clean install | Signed setup installs for a standard user on a clean Windows profile. |
| Upgrade | Installing the next signed version preserves settings and meeting records. |
| Uninstall | App and native camera are removed; user meeting records are handled according to the stated policy. |
| SmartScreen | Release behavior is documented; no unexpected unsigned-child warning occurs. |
| Release assets | Published EXE/NUPKG metadata matches the signed files. |

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
