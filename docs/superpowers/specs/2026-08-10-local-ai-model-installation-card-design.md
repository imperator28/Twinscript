# Local AI Model Installation Card Design

**Date:** 2026-08-10

**Status:** Approved design

**Selected layout:** Dedicated card with independent Whisper and HY-MT2 controls

## Summary

Twinscript adds an always-visible **Local AI Models** card directly below the existing Meeting Pipeline card in Settings. The card gives each local model its own installation lifecycle, progress, integrity state, device description, and maintenance actions. It follows the visible status/action pattern of the Virtual Camera card while preserving the independent transcription and translation choices already implemented.

Whisper and HY-MT2 are never installed implicitly or as a bundle. A user can install either model without installing the other. The selected pipeline remains authoritative: a missing selected local model blocks meeting startup, while unselected missing models do not prevent a cloud or hybrid meeting.

Production downloads come from an app-controlled release location described by an application-shipped, Ed25519-signed manifest. Every file is size- and SHA-256-verified before the model becomes Ready. A failed or incomplete installation is never treated as usable and never causes a silent switch to a cloud model.

## Required branch prerequisite

Before installation-card implementation begins, the feature branch must integrate main commit `40f8f00b` (`fix(audio): gibberish captions were 48 kHz audio in a 24 kHz session`). The branch currently diverges from main only by that main-side commit.

The prerequisite preserves four audio guarantees for both cloud and local transcription:

- the audio worklet asset is colocated with `BaseAudioRecorder` and remains package-visible;
- the ScriptProcessor compatibility path resamples captured PCM to the transport's declared rate;
- compatibility-path use is reported to the operator instead of remaining console-only; and
- worklet existence, processor-name agreement, and 48-to-24 kHz resampling remain regression-tested.

The integration must be resolved without discarding the feature branch's bounded PCM batching or local Whisper ingestion. The audio-capture regression tests must pass before model-installation work proceeds.

## Goals

- Make it obvious where Whisper and HY-MT2 are installed and maintained.
- Let users install or remove each model independently.
- Show useful state continuously instead of exposing only a missing-model warning at meeting start.
- Provide explicit, resumable, integrity-verified downloads.
- Keep model choice, model availability, and actual execution device truthful and distinct.
- Reuse the existing `LocalModelManager` rather than creating a second download implementation.
- Preserve the existing cloud main track and all hybrid/full-local privacy rules.

## Non-goals

- Bundling model weights into the base application installer.
- Automatically downloading a model when a user selects it in the pipeline card.
- Installing both models through one combined action.
- Allowing arbitrary models, repositories, versions, or user-supplied URLs.
- Changing transcription, final-translation, or acceleration selections during a meeting.
- Claiming HY-MT2 uses the NPU when its actual supported runtime remains CPU.
- Making energy optimization a release blocker.

## Placement and hierarchy

The card appears immediately after Meeting Pipeline and before unrelated Settings sections. It remains visible even when both cloud models are selected, so installation and cleanup actions never disappear because of the current pipeline configuration.

The card contains:

1. eyebrow: **LOCAL AI MODELS**;
2. heading: **Private, on-device processing**;
3. aggregate badge such as **2 not installed**, **1 downloading**, **Ready**, or **Action needed**;
4. one sentence explaining that models are optional and verified before use;
5. an independent Whisper row; and
6. an independent HY-MT2 row.

The Meeting Pipeline card retains its compact readiness chips. A selected missing chip links or scrolls to the corresponding row in Local AI Models. The existing startup-blocking warning remains concise and points to the same recovery action.

## Model rows

Each row shows stable identity information:

| Field | Whisper | HY-MT2 |
|---|---|---|
| Display name | Whisper | HY-MT2 |
| Purpose | Local transcription | Local translation |
| Packaged model ID | `whisper-small` | `hy-mt2-1.8b` |
| Expected execution | Intel NPU first | CPU in the validated first release |
| Download size | Read from signed manifest | Read from signed manifest |
| Version | Read from signed manifest | Read from signed manifest |

The UI must not hardcode byte counts or versions. It formats the signed manifest metadata returned by the main process. Device wording distinguishes expected/available device from actual device: before a session it says, for example, **Designed for Intel NPU**; after preparation it may say **Last ran on NPU**. HY-MT2 says **Runs locally on CPU** until a validated NPU runtime exists.

## States and actions

Each model row uses one state machine:

| State | Visible detail | Primary action | Secondary action |
|---|---|---|---|
| Checking | Checking installed files | disabled | none |
| Not installed | Download size and required free space | Install | none |
| Downloading | percent, downloaded bytes, total bytes | disabled progress button | Cancel only if cancellation is implemented safely |
| Verifying | Verifying downloaded files | disabled | none |
| Ready | version, installed size, device description | Verify | Remove |
| Repair needed | missing/corrupt/incompatible detail | Repair | Remove |
| Failed | actionable error and resumability note | Retry | Remove partial download when applicable |
| Meeting active | current state plus locked explanation | disabled | disabled |

The first implementation does not need download cancellation. If omitted, closing Settings or the control window does not cancel the main-process download; reopening Settings reconnects to the current status. Quitting the app leaves validated files intact and partial files resumable on the next explicit Retry.

**Install** starts only after a direct user click. **Verify** recalculates file size and SHA-256 rather than trusting `.verified.json` alone. **Repair** reuses valid files and downloads missing or corrupt files. **Remove** deletes only the selected model version after a confirmation naming the model and redownload requirement. It does not change the user's pipeline selection; the selected local option becomes unavailable until reinstalled.

## Download trust and release ownership

The base installer ships:

- the local inference runtimes and native host;
- a versioned model manifest;
- an Ed25519 signature over canonical manifest JSON; and
- the corresponding public verification key.

The manifest supplies model ID, version, runtime compatibility, license metadata, source attribution, download and installed sizes, HTTPS file URLs, and per-file SHA-256 values. Packaged builds fail closed if the manifest or signature is missing or invalid. Development and tests may inject an unsigned fixture manifest, but production code cannot enable an unsigned bypass.

Release engineering publishes the exact validated OpenVINO Whisper conversion and HY-MT2 GGUF to an app-controlled HTTPS location before enabling Install in a production build. Direct user-configurable Hugging Face URLs are not exposed. The release-owned package prevents upstream file replacement, pins the tokenizer/model pairing, and ensures the advertised runtime matches the downloaded artifact.

## Main-process integration

`captions-main.js` constructs one `LocalModelManager` after the signed manifest is loaded. Its root remains the application user-data local-model directory. The manager receives a `sessionActive` callback from the caption session manager and a progress callback that publishes renderer-safe status events.

The current manager remains the only writer of model files. It is extended as needed to expose explicit lifecycle phases and full verification:

- `status()` returns manifest metadata, installed state, partial-download state, and current progress;
- `download(modelId)` resumes HTTPS downloads and verifies before atomically writing `.verified.json`;
- `verify(modelId)` hashes every declared file and removes or invalidates a stale marker on failure;
- `remove(modelId)` removes only the selected model version; and
- concurrent mutation of the same model and all mutation during an active meeting are rejected.

Readiness has one source of truth. `LocalInferenceSupervisor.readiness()` consumes the model manager's verified paths/status instead of independently guessing installation from the filesystem. After install, verify, repair, or remove, the main process refreshes supervisor readiness and publishes the resulting snapshot.

## IPC and renderer contract

The preload exposes narrow methods rather than filesystem access:

- `getLocalModelStatus()`
- `installLocalModel(modelId)`
- `verifyLocalModel(modelId)`
- `removeLocalModel(modelId)`
- `onLocalModelStatus(callback)`

Only the two manifest model IDs are accepted. IPC converts thrown errors into the existing `Result` envelope and stable error codes. The renderer cannot provide a URL, destination path, hash, shell command, or executable path.

`LocalModelStatus` contains an aggregate runtime/manifest state and a keyed model snapshot with:

- model ID, display metadata, version, and byte counts;
- lifecycle phase;
- installed and verified booleans;
- downloaded and total bytes when active;
- repair recommendation and stable error code/message;
- expected device and last actual device when known; and
- whether actions are locked by an active meeting.

Initial load invokes `getLocalModelStatus()`. Subsequent progress and completion arrive through `onLocalModelStatus`, including progress started in a previous renderer lifetime. Event cleanup follows the existing native-camera health subscription pattern.

## Meeting readiness behavior

Availability is evaluated from the immutable processing selection:

- OpenAI transcription does not require Whisper.
- Local Whisper transcription requires verified `whisper-small`.
- Luna final translation does not require HY-MT2 unless local acceleration is enabled.
- Local HY-MT2 final translation requires verified `hy-mt2-1.8b`.
- Local translation acceleration requires verified `hy-mt2-1.8b` regardless of final model.

An unavailable selected local model blocks startup with its exact model name and an action that focuses its row. No cloud fallback is selected. An unavailable unselected model changes only the Local AI Models card and does not block startup.

Full-local mode still creates no OpenAI WebSocket, HTTP client, credential read, or content telemetry. Model-package network activity occurs only during an explicit pre-meeting install/repair operation; the native inference host remains offline during meetings.

## Failure handling

- A transient network failure leaves a bounded `.partial` file for a later explicit Retry.
- A server that ignores a Range request restarts that file safely instead of appending duplicate bytes.
- Size mismatch, hash mismatch, manifest incompatibility, or signature failure never becomes Ready.
- Hash-mismatched partial content is removed before another retry.
- Low-disk-space and permission errors identify the selected model and preserve other models.
- Renderer reload or Settings navigation does not duplicate a running download.
- Native-host unavailability is reported separately from model installation: installed weights can be Ready while runtime repair is required.
- Removing one model never removes the other model or shared runtime binaries.

## Accessibility and interaction

- State is never communicated by color alone; badges include text and an icon.
- Download progress uses a labelled native progress semantic and announces meaningful phase changes without announcing every byte update.
- Buttons retain visible focus, a minimum 44-pixel target, and descriptive accessible names such as **Install Whisper local transcription model**.
- Error copy is associated with its row and uses `role="alert"` only when an operation fails, not for the normal Not installed state.
- Reduced-motion users receive no animated indeterminate shimmer; a static checking indicator remains.

## Testing and release gates

### Branch and audio prerequisite

- Integrate `40f8f00b` before feature work.
- Pass the new worklet asset, processor-name, fallback transport, and resampling tests.
- Pass existing capture batching tests for both OpenAI and local Whisper input.

### Model manager

- Signed-manifest success and invalid/missing signature failure in packaged mode.
- Independent install and removal of each model.
- Resume after partial download and safe restart when Range is ignored.
- Exact progress, phase transitions, full verification, corruption detection, repair, and atomic marker creation.
- Same-model concurrency rejection and active-meeting mutation rejection.
- Path traversal, unknown model ID, bad URL, size mismatch, and hash mismatch rejection.

### IPC and UI

- Initial state, progress subscription, renderer remount, and listener cleanup.
- All row states and actions for Whisper and HY-MT2.
- One installed model never marks the other Ready.
- Remove confirmation and selected-model readiness update.
- Meeting-active controls are disabled with an explanation.
- Pipeline chips focus the correct model row.
- Cloud/cloud remains startable with neither model installed.
- Every hybrid/full-local selection blocks only on the model it actually requires.

### Packaging and release

- Runtime binaries, manifest, signature, and public key are present in the packaged application.
- Model weights are absent from the base installer.
- Production URLs resolve over HTTPS to the exact signed sizes/hashes.
- A clean installed application can install each model independently, restart, verify readiness, run a meeting, remove the model, and observe readiness become unavailable.
- Full-local privacy tests remain green after model installation.

Production enablement remains gated on publishing the signed release artifacts. The UI may be developed against injected local HTTP fixtures, but a production build must present a clear **Downloads unavailable in this build** state rather than accepting unsigned or unowned artifacts.

## Rollout

1. Integrate and verify main's audio-sampling fix.
2. Define and sign the release manifest, publish the validated model artifacts, and add clean-machine download fixtures.
3. Instantiate `LocalModelManager` in the main process and unify supervisor readiness with it.
4. Add IPC methods, status events, and renderer types with contract tests.
5. Add the dedicated Local AI Models card and pipeline-to-row recovery links.
6. Exercise download interruption, corruption, repair, removal, meeting locks, and renderer reload.
7. Run the complete caption, renderer, native-host, package, privacy, and clean-install gates before enabling production downloads.
