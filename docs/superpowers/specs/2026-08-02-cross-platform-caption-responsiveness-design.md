# Cross-platform caption responsiveness and projection design

**Date:** 2026-08-02  
**Status:** Approved 2026-08-02  
**Supersedes:** the Visible-history sizing rule in
`2026-07-30-overlay-focus-sizing-themes-design.md`

## Goal

Make bilingual captions easier to follow when transcription runs ahead of
translation, repair the Windows native-camera installation path, and make the
caption projections respond predictably to Visible history on Windows and
macOS.

The normal meeting experience must remain functionally equivalent on Windows
and macOS. The only deliberate platform exception is the Windows 11 native
virtual-camera driver. macOS retains the camera-stage preview and the OBS
capture route, but this work does not add a macOS CoreMediaIO/DriverKit virtual
camera extension.

## Accepted product decisions

- `gpt-live-transcribe` remains the realtime transcription model.
- GPT-5.6 Luna remains authoritative for final bilingual normalization.
- An optional, on-demand local engine may produce a fast draft while the final
  translation is pending.
- Local drafts never replace, delay, or enter the saved transcript as final
  text.
- The app uses one cross-platform local-draft contract with platform-native
  implementations:
  - Windows uses an INT4 Hy-MT2 1.8B artifact through Windows ML and the
    hardware execution provider selected for the PC.
  - macOS uses Apple's on-device Translation framework with the low-latency
    strategy.
- Local inference maximizes NPU use but does not claim that every operator is
  guaranteed to execute on an NPU. Unsupported hardware falls back according
  to the policy below rather than silently consuming excessive CPU.
- Local language resources download only after the user enables the feature.
- Increasing Visible history may grow the desktop overlays automatically.
- Automatic layout changes must not shrink an overlay below the height the
  user most recently chose by dragging it. The user can always drag it smaller.
- English and Chinese desktop overlays always have equal height.
- The 16:9 camera stage supports both stacked and side-by-side layouts, with
  both layouts using the full frame.

## Platform capability contract

| Capability | Windows | macOS |
| --- | --- | --- |
| Control application and session lifecycle | Same UX | Same UX |
| Microphone and system/meeting capture | Supported | Supported with normal macOS permission prompts |
| Live transcription and Luna final translation | Same pipeline | Same pipeline |
| Optional local draft | Windows ML native helper | Apple Translation native helper |
| On-demand model/language download UI | Same states and controls | Same states and controls |
| Desktop English/Chinese overlays | Same behavior | Same behavior |
| Synced manual height and automatic growth | Same behavior | Same behavior |
| Camera-stage preview | Same behavior | Same behavior |
| Stacked/side-by-side stage layout | Same behavior | Same behavior |
| OBS capture route | Supported | Supported |
| App recording, records, glossary, and themes | Same behavior | Same behavior |
| Native virtual-camera driver | Windows 11 x64 only | Not included |

Platform-specific explanatory copy may differ, but settings placement, state
names, progress behavior, and the session workflow remain the same.

## Translation architecture

### Shared local-draft boundary

Electron owns a `LocalDraftTranslator` interface independent of the renderer:

```text
probe() -> availability, accelerator, download state, estimated storage
prepare(pair) -> progress stream and ready state
translate(request) -> cancellable draft result plus timing/provider metadata
cancel(requestId)
remove(pair)
dispose()
```

A request contains the stable partial or final source text, detected source
language, target language, matched glossary terms, and at most the two most
recent settled caption pairs. The native helper returns plain translated text;
it cannot mutate caption state directly.

All helper messages use a versioned, length-bounded JSON protocol over local
standard I/O. Audio and API credentials never enter the helper. Paths are
resolved from packaged resources or the app's model-data directory and are
never accepted from renderer input.

### Windows engine

The Windows source model is `tencent/Hy-MT2-1.8B`, Apache-2.0. The downloadable
artifact is derived from the same versioned source weights and optimized as a
symmetric INT4, stateful text-generation model.

Windows ML is the runtime boundary. Its execution-provider catalog selects the
available vendor path:

- Intel NPU: OpenVINO;
- Qualcomm NPU: QNN;
- AMD NPU: VitisAI; and
- supported GPU only as an explicit fallback.

The current development PC has an Intel Core Ultra 7 165H, Intel AI Boost, and
NPU driver `32.0.100.4724`, which exceeds OpenVINO's documented
`32.0.100.3104` minimum. The first implementation target is therefore the
OpenVINO NPU path on this machine.

An optimized artifact is accepted only after a deployment probe confirms:

1. the intended execution provider loaded;
2. model compilation completed;
3. a fixed EN-to-ZH and ZH-to-EN smoke corpus produces valid output; and
4. runtime telemetry identifies the accelerator actually used.

If NPU compilation fails, the UI reports the reason and may offer a supported
GPU fallback. It does not silently select CPU for the 1.8B model. Provider-
specific compiled caches are local and disposable; source text is not written
to those caches.

### macOS engine

The macOS helper is a small universal SwiftUI agent application (`LSUIElement`)
using Apple's Translation framework. A minimal hidden host view owns the
`translationTask` required for first-time language-download permission; once
languages are installed, the helper uses the direct session initializer. It
requests the `lowLatency` strategy and lets macOS manage the on-device language
resources and hardware scheduling. Apple silicon is the accelerated target;
on an Intel Mac, the helper uses the system path when macOS reports it
available and otherwise leaves local drafts off while the normal cloud-final
pipeline remains fully usable.

The helper exposes the same `probe`, `prepare`, `translate`, `cancel`, and
`dispose` semantics as Windows. Apple's language-availability and download
states are mapped into the shared UI states. On newer macOS releases it
explicitly requests `lowLatency`; on macOS 15 where Strategy is unavailable it
uses the framework's traditional-model default. Protected glossary tokens are
masked before translation and restored afterward; compact matched-term hints
are applied where the framework permits them.

This route is preferred over a custom Hy-MT2 Core ML conversion because it is
the supported system translation path, provides the best macOS compatibility,
and allows Apple to schedule work across the Neural Engine, GPU, and CPU.
Apple does not expose a contract guaranteeing that every translation operator
runs on the Neural Engine, so the product wording is "on-device optimized," not
"100% Neural Engine."

The helper requires no system extension or virtual-camera entitlement. A
distributed macOS application still needs the ordinary app signing and
notarization process, but this feature does not introduce the additional
virtual-camera extension work excluded from this scope.

### Download and readiness UX

The existing Settings surface gains one shared **Instant local draft** control.
When off, no model or language pack is downloaded.

When enabled, the control uses the same state model on both platforms:

```text
Not installed -> Download -> Preparing -> Ready
                    |             |
                    +-> Failed <--+
Ready -> Remove
```

The UI shows platform engine, accelerator when discoverable, approximate
storage, progress, and a retry action. Download/preparation never blocks the
rest of Settings or **Start session**. A session started during preparation
uses cloud final translation immediately and begins using local drafts only
after the helper reports ready.

### Draft and final scheduling

The two tiers run independently:

1. A stable partial is eligible for one local draft after a short debounce.
2. A newer revision cancels the older local request for that caption.
3. A local result is displayed only when its source revision is still current.
4. Final transcription immediately enters the cloud-final lane.
5. When Luna settles, it atomically replaces the draft.
6. If Luna finishes first, the local result is discarded.

Local work cannot occupy the cloud scheduler's concurrency slots. The cloud
scheduler reserves capacity for final requests and removes obsolete
provisional work before accepting more.

For monolingual input, the final lane calls Luna only for the opposite
language; the source language passes through. Mixed-language input uses one
structured Luna request returning both English and Chinese rather than two
independent calls.

The final prompt includes the current utterance, matched glossary rows, and a
bounded rolling context of the two most recent settled caption pairs. This
improves pronouns and terminology without allowing context size or latency to
grow throughout the meeting.

### Caption state and persistence

Each target retains explicit state:

```text
source -> local-draft | cloud-pending -> final | failed
```

The audience UI may show a subtle `Draft`/`Translating` treatment, but the row
remains full-size and full-opacity while either target is pending. All
in-flight rows and the two newest settled rows remain in the focus cohort.

Only settled final text is written to JSONL, Markdown, copied records, and the
camera-stage completed-history buffer. Draft text is memory-only.

## Desktop overlay history and sizing

### Retained caption buffer

`CaptionSurface` retains at least the ten newest settled captions plus every
in-flight caption. Visible history is derived from that buffer; changing the
slider never destructively removes entries that may become visible again.

This fixes the current failure where selecting a larger history count cannot
restore rows already pruned under the smaller count.

### Manual height as a floor

The window manager keeps two independent values:

```text
manualHeightFloor = latest height explicitly chosen by dragging
contentRequiredHeight = larger natural height reported by EN and ZH surfaces
effectiveHeight = max(manualHeightFloor, contentRequiredHeight)
```

If the user has never manually resized, `manualHeightFloor` is absent and the
overlay follows natural content in both directions. Once the user drags either
panel, that result becomes the shared floor.

- More visible history or taller content may grow both panels above the floor.
- Less history, translation settlement, or shorter content cannot shrink them
  below the floor.
- Dragging either panel smaller explicitly replaces the floor with the new
  user-selected height.
- Both panels update continuously and remain equal.
- Geometry remains bottom-anchored and work-area clamped.

Changing Visible history no longer clears `captionOverlayHeight`. Existing
generation guards still reject stale content measurements.

## Camera-stage projection

### Full-frame layouts

The layout setting applies to desktop overlays and the camera stage.

- **Stacked:** English and Chinese are full-width rows, each receiving half of
  the usable 16:9 frame.
- **Side by side:** English and Chinese are full-height columns, each receiving
  half of the usable frame.

Both modes preserve the 5% title/action safe area and consume the full stage.
The control remains visible when Virtual camera is selected rather than being
replaced by installation guidance.

### History-aware typography

The stage derives a typography density token from layout, visible-history
count, and the actual safe-area dimensions. Increasing history reduces
headline size and row gaps within a bounded readable range so the requested
number of completed entries fits whenever normal caption lengths allow.

Text never scales below the approved remote-readability floor. Excessively long
captions wrap and then scroll/clip within their own audience region rather than
changing the 16:9 stage size or pushing the other language off-screen.

Preview and offscreen Windows-camera rendering consume the same React stage,
settings snapshot, and CSS tokens, preventing visual drift.

### Preview lifecycle

The single control is stateful:

- **Show preview** opens the frameless stage.
- **Hide preview** closes/hides it.
- Escape hides the focused preview.
- Starting a session in virtual-camera mode does not open desktop lower-third
  overlays.

On macOS the same preview behavior is available. The output area explains that
OBS can capture the stage and omits the Windows native-camera install action.

## Windows native-camera repair

The current generic `Native camera action failed (exit 1)` is insufficient.
The installer becomes a stage-reporting operation:

```text
preflight -> stage files -> prepare ACL -> remove legacy registration
          -> register source -> verify registration -> verify companion
```

Each stage writes a sanitized log under the app's camera log directory and
returns a structured result with stage, Win32/HRESULT value, and recovery hint.
Electron captures that result instead of launching PowerShell with ignored
standard output.

Repair is idempotent. It validates staged hashes before registry mutation,
handles the known legacy `C:\Users\Public\twinscript-vcam3` registration, and
does not remove a working registration until replacement binaries are ready.
The UI exposes **Retry installation**, **Open diagnostics**, and the OBS
fallback. Camera failure never stops transcription or recording.

All native-camera imports, IPC handlers, packaged resources, and UI actions
remain gated to Windows 11 x64. macOS builds must neither load Windows-only
modules nor expose unusable install buttons.

## Settings and migration

New settings are platform-neutral:

```text
localDraftEnabled: boolean = false
localDraftAllowGpuFallback: boolean = true
```

The existing `layout` setting becomes the authoritative shared projection
layout for desktop overlays, the visible camera preview, and the offscreen
Windows native-camera stage. No second camera-only layout preference is added.

`captionOverlayHeight` changes meaning from an exclusive manual height to a
manual height floor. Existing valid values migrate without reset.

Downloaded models, compiled caches, and Apple language resources are not part
of configuration export. Export stores only the preference and selected
fallback policy.

## Failure behavior

- Local engine unavailable: continue with cloud final translation and show a
  nonblocking explanation.
- Model preparation fails: retain any previous working local engine; session
  controls recover immediately.
- Draft queue falls behind: discard obsolete drafts rather than queueing them.
- Cloud final falls behind: preserve source captions, prioritize final work,
  and show one background backlog indicator.
- Local helper exits: restart once outside an active request, then disable
  drafts for the session if it exits again.
- Apple language pack unavailable: offer system-managed download; cloud final
  remains available.
- Windows NPU provider unavailable: offer verified GPU fallback or leave local
  drafts off; do not silently use the 1.8B model on CPU.
- Height reports arrive out of order: ignore older generation reports.
- One overlay is missing: size the remaining panel from its valid report while
  preserving the shared floor for recreation.
- Camera installation fails: preserve transcription, preview, and OBS output.

## Verification strategy

### Shared automated tests

- Local draft results apply only to the matching caption revision.
- New partial/final revisions cancel obsolete local work.
- Luna final always replaces a draft and is the only persisted translation.
- Monolingual finalization performs one translation request; mixed speech
  performs one joint bilingual request.
- Rolling context remains capped at two settled pairs and glossary budgets
  remain bounded.
- Caption buffers preserve ten settled rows independently of the visible slice.
- Increasing history reveals retained entries immediately.
- Manual height is a floor, automatic content can grow above it, and automatic
  changes cannot shrink below it.
- Explicit user resizing can establish a smaller floor.
- Both panels receive equal effective height on Windows and macOS geometry.
- Camera-stage stacked and side-by-side layouts fill the safe frame.
- History density produces bounded, monotonically smaller typography.
- Non-Windows builds do not load or expose the native-camera implementation.

### Windows automated and hardware tests

- Execution-provider probe reports Intel OpenVINO on the development PC.
- INT4 model compile, warm translation, cancellation, and cache reuse work.
- Provider telemetry proves NPU execution; fallback is never mislabeled.
- EN-to-ZH and ZH-to-EN glossary corpus passes basic quality checks.
- Installer reports the exact failed stage and retains its diagnostic log.
- Legacy registration migrates to the verified ProgramData installation.
- Registration, repair, removal, and second repair are idempotent.
- Preview and offscreen native-camera surfaces render identical layout tokens.

### macOS automated and hardware tests

- The Swift helper compiles for Apple silicon and is packaged with the app.
- Permission, language availability, preparation, cancellation, and helper
  restart states map to the shared protocol.
- EN-to-ZH and ZH-to-EN drafts preserve protected glossary tokens.
- Microphone/system capture, overlays, camera preview, recording, meeting
  records, reveal-folder, themes, and session lifecycle match Windows behavior.
- The app contains no attempted native-camera registration or driver prompt.
- An ad-hoc development build runs locally; signed/notarized packaging remains
  a release gate rather than a feature-development blocker.

### Performance gates

Measure after warmup on representative 5-, 15-, and 30-word EN/ZH segments:

- local draft first result p50 at or below 700 ms;
- local draft p95 at or below 1,200 ms;
- cancellation prevents an obsolete draft from appearing;
- cloud final receives its request immediately after transcript finalization;
- final translation queue age does not grow without bound during a five-minute
  fast-speaking fixture; and
- enabling local drafts does not increase transcription event latency by more
  than 50 ms p95.

If a platform-native engine misses the draft latency gate, the app suppresses
that draft instead of showing it after the authoritative final.

## Manual validation checklist

- Enable the local engine from a clean install and observe progress while the
  rest of Settings remains usable.
- Speak alternating English and Chinese quickly; confirm drafts appear early,
  remain visibly provisional, and settle cleanly to Luna output.
- Confirm glossary terms and product codes remain stable in draft and final.
- Run five minutes of rapid speech and confirm final translations catch up.
- Resize either desktop panel, increase history, then decrease it; confirm both
  panels grow as needed but do not automatically shrink below the manual size.
- Drag the overlay smaller and confirm the explicit user resize is respected.
- Exercise stacked and side-by-side desktop and camera-stage layouts.
- Change history from 3 through 10 in camera mode and confirm type scales while
  the full 16:9 stage remains occupied.
- Hide the preview with its button and Escape; confirm hidden preview does not
  alter an active Windows native-camera feed.
- On macOS, repeat the meeting workflow through recording export and OBS stage
  capture; confirm native-camera installation is absent.
- On Windows, run native-camera install/repair and confirm a precise diagnostic
  replaces the generic exit-code banner if any stage fails.

## Out of scope

- A macOS native virtual-camera system extension.
- Claiming guaranteed 100% NPU/Neural Engine execution when an OS or execution
  provider does not expose that guarantee.
- Persisting local draft text in meeting records.
- Replacing GPT-5.6 Luna as the authoritative final translation.
- Bundling local model weights in the installer.
- Shipping Windows-on-Arm NPU artifacts in the first implementation pass. The
  shared Windows ML boundary preserves a later QNN route.

## References

- Windows ML overview:
  <https://learn.microsoft.com/en-gb/windows/ai/new-windows-ml/overview>
- Windows ML execution providers:
  <https://learn.microsoft.com/en-ie/windows/ai/new-windows-ml/supported-execution-providers>
- ONNX Runtime GenAI:
  <https://github.com/microsoft/onnxruntime-genai>
- OpenVINO GenAI on NPU:
  <https://docs.openvino.ai/2026/openvino-workflow-generative/inference-with-genai/inference-with-genai-on-npu.html>
- Hy-MT2 1.8B model card and Apache-2.0 license:
  <https://huggingface.co/tencent/Hy-MT2-1.8B>
- Apple Translation strategy:
  <https://developer.apple.com/documentation/translation/translationsession/strategy>
- Apple Core ML compute units:
  <https://developer.apple.com/documentation/coreml/mlcomputeunits>
- OpenAI realtime transcription:
  <https://developers.openai.com/api/docs/guides/realtime-transcription>
- OpenAI GPT-5.6 Luna:
  <https://developers.openai.com/api/docs/models/gpt-5.6-luna>
