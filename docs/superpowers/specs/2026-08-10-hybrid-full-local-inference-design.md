# Hybrid and Full-Local Inference Design

**Date:** 2026-08-10

**Status:** Approved design

**Initial platform:** Windows 11 on Intel Core Ultra hardware

**Models:** OpenAI live transcription, Whisper small, Luna, Hy-MT2-1.8B

## Summary

Twinscript keeps its current cloud pipeline as the default main track and adds independent transcription and translation model choices. Users can combine OpenAI live transcription or local Whisper with Luna or local Hy-MT2. The existing early-caption setting continues to decide whether provisional translation is shown. A separate local-translation-acceleration switch chooses Hy-MT2 as that provisional engine while the selected final translation model completes.

The selected final translation model is always authoritative. A provisional local result never changes which engine owns the final persisted translation.

The first implementation targets Windows and uses a dedicated native inference host. The host requests Intel NPU execution first, reports the device that actually ran each model, and may fall back only to local GPU or CPU execution. The fully local combination fails closed: it never silently starts a cloud session or sends meeting content to OpenAI.

## Goals

- Preserve the existing OpenAI live-transcription plus Luna pipeline as the default and regression baseline.
- Let users select transcription and final translation engines independently.
- Provide faster translated captions through optional, cancellable local Hy-MT2 previews.
- Provide a fully local Whisper plus Hy-MT2 pipeline for private meetings.
- Use the Intel NPU whenever the selected models run there correctly and without destabilizing live captions.
- Keep model crashes, native dependencies, and large allocations outside the Electron renderer and caption process.
- Make provisional, final, local, and cloud provenance unambiguous in memory, UI state, and persisted records.

## Non-goals

- Reintroducing the inherited Sokuji provider UI or its general-purpose sidecar architecture.
- Supporting arbitrary ASR or translation models in the first release.
- Guaranteeing that every local inference request uses the NPU when the runtime or model cannot support it.
- Treating energy measurements as a release blocker. They are useful diagnostics, while responsiveness, correctness, and privacy are required gates.
- Shipping macOS local inference in the first implementation. The backend contracts remain portable for a later macOS phase.
- Switching engines during an active meeting.

## User controls

Settings expose three controls while no meeting is running.

### Transcription model

- **OpenAI live transcription** — the current WebSocket transcription implementation.
- **Local Whisper** — Whisper small running in the local inference host.

### Final translation model

- **Luna** — the current cloud translation and normalization implementation.
- **Local Hy-MT2** — Hy-MT2-1.8B running in the local inference host.

### Local translation acceleration

- **Off** — when early captions are enabled, the selected final translation model also produces provisional translations, preserving today's Luna behavior.
- **On** — when early captions are enabled, Hy-MT2 produces cancellable provisional translations while an utterance is still changing. The selected final translation model still produces the authoritative result.

Acceleration defaults to off. Existing installations migrate to OpenAI live transcription, Luna final translation, and acceleration off without changing their existing `provisionalTranslation` preference.

## Supported combinations

| Transcription | Final translation | Acceleration | Result |
|---|---|---:|---|
| OpenAI | Luna | Off | Current main track; Luna provides provisional and final output when early captions are enabled |
| OpenAI | Luna | On | Hy-MT2 preview followed by authoritative Luna output |
| OpenAI | Hy-MT2 | Off | Cloud transcript with Hy-MT2 provisional and authoritative translation |
| OpenAI | Hy-MT2 | On | Cancellable Hy-MT2 previews followed by an authoritative Hy-MT2 final pass |
| Whisper | Luna | Off | Audio stays local; Luna receives transcript text for provisional and final translation |
| Whisper | Luna | On | Local transcript and Hy-MT2 preview followed by authoritative Luna output |
| Whisper | Hy-MT2 | Off | Fully local Hy-MT2 provisional and authoritative translation |
| Whisper | Hy-MT2 | On | Fully local provisional and authoritative translation |

Only Whisper plus Hy-MT2 qualifies for the UI statement that no meeting audio or text leaves the computer. Whisper plus Luna keeps audio local but sends finalized transcript text and bounded context to OpenAI.

## Architecture

The current caption session manager remains the meeting orchestrator. It resolves an immutable processing configuration before starting a meeting and talks to narrow backend contracts rather than model-specific transports.

### Processing configuration

`ProcessingConfiguration` contains:

- `transcriptionModel`: `openai-live` or `whisper-local`
- `finalTranslationModel`: `luna` or `hy-mt2-local`
- `localTranslationAcceleration`: boolean
- `localDevicePreference`: initially `npu-first`

The configuration is copied into the session domain object at startup. Settings changes are disabled until the session stops.

### Transcription backend

`TranscriptionBackend` provides:

- capability and readiness probing
- session preparation for the selected language pair
- participant and system-audio channel startup
- bounded PCM ingestion
- partial and final transcript events
- flush, cancellation, and disposal
- model, runtime, timing, and actual-device metadata

The existing live-transcription session becomes the `openai-live` implementation without changing its external behavior. `LocalWhisperBackend` delegates to the native host.

### Translation backend

`TranslationBackend` provides:

- capability and readiness probing
- language-pair preparation
- cancellable provisional translation
- priority final translation
- cancellation and disposal
- model, runtime, timing, and actual-device metadata

The existing Luna normalizer becomes the `luna` implementation. `LocalHyMt2Backend` delegates to the native host.

### Translation policy

`TranslationPolicy` owns provisional and authoritative-result rules. The combination table assumes the existing early-caption preference is enabled; when it is disabled, no provisional backend runs.

- Early captions disabled schedules no provisional request.
- Early captions enabled with acceleration off uses the selected final translation backend for provisional requests.
- Early captions enabled with acceleration on uses Hy-MT2 for provisional requests.
- Provisional translation debounces changing text and permits at most one running request per utterance.
- A new transcript revision cancels or invalidates the previous provisional request.
- A finalized utterance cancels its provisional work and schedules exactly one request with the selected final translation backend.
- If Hy-MT2 is both accelerator and final backend, its final pass is a distinct priority request over the finalized source text.
- Only the selected final backend may mark a translation authoritative or persist it.
- Late provisional results are discarded by utterance ID and source revision.

## Local inference host

The Windows local runtime is a self-contained native process launched and supervised by the Electron main process. It communicates through a versioned, bounded stdin/stdout protocol. It does not receive API keys and does not open network connections during meetings.

### Initial runtime and models

- OpenVINO GenAI C++ is the primary inference runtime.
- Whisper small, quantized for supported OpenVINO NPU execution, is the initial local ASR model.
- Hy-MT2-1.8B with an INT4 target is the initial local translation model.
- A feasibility gate must prove Hy-MT2 export, tokenizer compatibility, generation correctness, and NPU compilation before NPU support is advertised.
- If Hy-MT2 cannot run correctly on the NPU, it runs through the same host on an OpenVINO GPU or CPU device.

Python may be used for model conversion and development experiments. Production does not require a user-installed Python runtime.

### Device policy

The host probes `NPU`, then OpenVINO `GPU`, then `CPU`. It returns both the requested and actual execution device. Selection is stable for the session unless a device-level inference failure requires a local restart.

Whisper receives priority for continuous NPU residency. If Whisper and Hy-MT2 cannot remain resident together without stalls, model thrashing, or memory failure, Whisper stays on the NPU and Hy-MT2 uses the next viable local device. Models are never reloaded per utterance.

The first release does not add a separate NVIDIA CUDA runtime. The Intel OpenVINO GPU and CPU paths provide local fallback while keeping packaging bounded. CUDA can be considered after the NPU-first path is stable.

### Protocol

Every request contains a protocol version, request ID, session ID, channel, and operation-specific payload. Audio and queues are explicitly bounded.

Required operations are:

- `hello` / `capabilities`
- `model.prepare` / `model.ready`
- `asr.start`, `asr.audio`, `asr.flush`, and `asr.stop`
- `translate.preview`, `translate.final`, and `request.cancel`
- `health`, `error`, and `shutdown`

ASR events carry utterance ID, revision, partial/final state, source language, text, audio duration, inference timing, model version, runtime, and actual device. Translation events carry utterance ID, source revision, provisional/authoritative state, target language, text, inference timing, model version, runtime, and actual device.

The protocol applies backpressure rather than permitting unbounded audio or translation queues. Continuous ASR has priority over translation previews. Final translation has priority over preview translation.

## Session data flow

### OpenAI transcription

The existing PCM path and two live-transcription WebSockets remain unchanged. Partial and final events are normalized into the common transcription event shape before sentence assembly.

### Local Whisper transcription

The existing participant and system PCM streams are sent to the host. The host resamples to Whisper's required input format and maintains separate per-channel segmentation and decoding state. VAD-bounded overlapping windows produce volatile partial text. Flushing an utterance produces its authoritative transcript. The existing sentence assembly and meeting-record layers consume the normalized results.

### Translation acceleration

When acceleration is enabled, stable partial or assembled text starts a debounced Hy-MT2 preview. Preview work is best effort and cancellable. It must never delay transcription, sentence finalization, or a final translation request.

### Final translation

Each finalized source utterance produces exactly one final request to the selected final backend. Luna remains the current authoritative cloud path when selected. Hy-MT2 becomes the authoritative persisted translation when selected.

## Failure and privacy behavior

- The application validates selected local model readiness before starting a meeting.
- A missing, corrupt, or incompatible selected local model blocks startup with a specific recovery action. It does not silently select a cloud model.
- In full-local operation, the OpenAI transcription factory, Luna client, credential store, HTTP client, and WebSocket constructor are not invoked.
- Local device failure may retry the same selected model on a local GPU or CPU.
- In OpenAI-plus-Hy-MT2 operation, Hy-MT2 failure leaves source captions running and marks translation unavailable; it does not call Luna.
- When Luna is the selected final model and a Hy-MT2 preview fails, Luna continues and its final result remains authoritative.
- When Luna fails after a successful local preview, the preview may remain visible with a clear non-final/error state, but it is not silently promoted or persisted as authoritative.
- A host crash ends local inference, invalidates outstanding request IDs, and permits one supervised local restart. Full-local operation remains offline during recovery.
- Stale events from a previous host generation, session, utterance revision, or cancelled request are discarded.

## Model distribution

Local weights are not embedded in the base application installer. A signed model manifest supplies model ID, version, runtime compatibility, source, license, download size, unpacked size, file list, and SHA-256 hashes.

Downloads are explicit, resumable, hash-verified, and stored in application user data. Users can remove models while no meeting is active. A meeting never initiates an implicit model download. Runtime binaries are packaged and signed with the application; model licenses and notices appear in About and the download confirmation.

## UI behavior

The settings surface uses independent segmented slide switches for transcription and final translation plus a toggle for local acceleration. The selected model names are visible without opening an advanced panel.

When a selected option requires local inference, readiness displays:

- model download and verification state
- required storage
- runtime readiness
- requested device preference
- actual active device after preparation
- actionable errors

The fully local privacy statement is shown only for Whisper plus Hy-MT2. Other combinations describe precisely whether audio or finalized transcript text reaches OpenAI. Settings remain disabled while a meeting is running.

## Persistence and provenance

Meeting records retain the existing source and translated text fields and add enough provenance to explain how each authoritative value was produced:

- transcription engine, model version, runtime, and actual device
- final translation engine, model version, runtime, and actual device
- whether a local preview was shown
- finalization timestamp and source revision

Provisional translations remain memory-only and are never exported as final meeting data.

## Testing and release gates

The integration suite covers all sixteen combinations of transcription engine, final translation engine, acceleration state, and the existing early-caption preference.

Required gates are:

- The current OpenAI-plus-Luna path retains its behavior and does not regress materially in latency.
- Warm Hy-MT2 acceleration reduces median time to first translated caption by at least 30 percent against the selected final-only path on the release corpus.
- Provisional results cannot overwrite, outlive, or be persisted in place of the selected authoritative result.
- Whisper is evaluated on recorded English, Mandarin, and code-switched meetings, including names, numbers, units, and engineering terminology.
- Whisper quality stays within 25 percent relative WER/CER of OpenAI live transcription on the same release corpus, with no systematic number or unit loss.
- Hy-MT2 receives human EN-to-ZH and ZH-to-EN adequacy review against Luna and must preserve at least 95 percent of names, numbers, units, and active glossary terms.
- Full-local integration tests prove that no OpenAI WebSocket, HTTP request, credential read, or content telemetry occurs.
- NPU claims require runtime evidence that the actual execution device is the NPU. CPU-only or GPU execution is never labeled NPU.
- NPU failure falls back only to local GPU or CPU execution and does not change the user's selected models.
- Cancellation, rapid revisions, host restart, corrupt models, insufficient memory, and 60-minute sessions create no stale authoritative results or unbounded queue growth.
- Downloads resume safely, verify all hashes, and cannot begin during an active meeting.

Energy, average power, and thermal behavior are measured for NPU, GPU, and CPU runs and included in release notes or engineering records, but they are not release blockers.

## Rollout

1. Prove Whisper small and Hy-MT2-1.8B independently on the target Windows hardware, including actual-device evidence.
2. Prove simultaneous residency and define the stable device allocation policy.
3. Add backend contracts and translation-policy tests without changing the default cloud behavior.
4. Add the supervised local host and model manager behind development flags.
5. Integrate local Whisper, then authoritative local Hy-MT2, then acceleration previews.
6. Add settings, readiness, privacy copy, and provenance.
7. Run the full matrix, long-session, packaging, and privacy gates before enabling local options in production builds.

The implementation may proceed to application integration only after the runtime feasibility gates pass. Failure of Hy-MT2 NPU execution does not block local translation development; it changes the actual device to GPU or CPU while preserving the NPU-first policy and truthful UI.
