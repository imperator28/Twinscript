# HY-MT2 automatic CUDA acceleration

**Date:** 2026-08-25

**Status:** Approved design

**Initial platform:** Windows 11 x64

**Primary accelerator:** NVIDIA CUDA

**Fallback:** Existing llama.cpp CPU runtime

## Summary

Twinscript will automatically run local HY-MT2 translation on a compatible
NVIDIA GPU when a packaged CUDA runtime can start and allocate the model. If
CUDA is unavailable or fails, Twinscript will restart HY-MT2 once on the
existing CPU runtime without changing the user's selected translation model.

This change accelerates execution only. HY-MT2 remains the selected and
authoritative final translation model whenever the user chooses it. Whisper
continues to run through OpenVINO on the NPU. Fully local meetings remain local
under both CUDA and CPU execution.

The design extends the device policy in
`2026-08-10-hybrid-full-local-inference-design.md`. It supersedes only that
document's decision to defer a separate CUDA runtime.

## Goals

- Reduce warm HY-MT2 translation latency on supported NVIDIA hardware.
- Select CUDA automatically without adding a required user setting.
- Preserve a tested CPU path on unsupported, busy, or low-memory systems.
- Report the actual device and fallback reason truthfully in readiness and
  session diagnostics.
- Keep Whisper resident on the Intel NPU while HY-MT2 uses the discrete GPU.
- Preserve offline privacy and final-model authority.
- Keep runtime selection stable for the duration of a meeting.

## Non-goals

- Moving Whisper from the NPU to CUDA.
- Running HY-MT2 on the Intel NPU in this work package.
- Shipping Vulkan, SYCL, ROCm, or multi-GPU support in the first accelerated
  release.
- Switching between CUDA and CPU for individual utterances.
- Claiming that GPU acceleration improves translation quality. It reduces
  execution latency; quality remains governed by HY-MT2, its quantization, and
  the translation pipeline.
- Treating energy optimization as a release blocker.

## Observed baseline

The current HY-MT2 runtime is llama.cpp b9940 built with CPU backends only. It
is launched with `--gpu-layers 0`, and `--list-devices` reports no accelerator.
The verified Q4_K_M model is approximately 1.1 GB. Existing feasibility results
show roughly 0.7 to 2.1 seconds of inference for short translations on CPU, with
longer utterances taking longer.

The initial review machine has an NVIDIA RTX 3000 Ada Generation Laptop GPU
with 8 GB of VRAM. The runtime must not assume all of that memory is free:
desktop applications may already consume a substantial share when a meeting
starts.

The latest reviewed meeting record contained correct authoritative Chinese
translations. The reported failure was therefore primarily delayed presentation
of the Chinese result, not absence of the final translation. Accelerator work
must measure both inference time and user-visible final-caption latency.

## Runtime packaging

Twinscript packages two pinned, signed llama.cpp runtime families:

- `llama/cpu/` contains the existing CPU server and its dependent libraries.
- `llama/cuda/` contains a CUDA-enabled server built from the same pinned
  llama.cpp revision, plus the exact CUDA runtime libraries it requires.

The two runtime families are isolated in separate directories so similarly
named backend libraries cannot be loaded from the wrong build. The application
does not depend on a user-installed CUDA toolkit. It does require a compatible
NVIDIA display driver.

The release manifest records the llama.cpp revision, runtime family, complete
file list, sizes, and SHA-256 hashes. Packaging and signature verification cover
every executable and DLL in both families. A partial CUDA runtime is treated as
unavailable rather than mixed with CPU files.

The current CPU runtime stays present in every Windows package. CUDA is an
acceleration capability, never the only way to run a selected local translation
model.

## Device probing and selection

The Electron main process performs a bounded, side-effect-free CUDA capability
probe before preparing HY-MT2. The probe launches the packaged CUDA server with
its device-list operation and accepts CUDA only when all of the following are
true:

- the CUDA runtime file set passes integrity checks;
- the process starts within the probe timeout;
- it reports at least one usable CUDA device;
- the reported device is an NVIDIA GPU;
- the process exits normally after the probe.

Detection does not rely only on `nvidia-smi`, device names from Windows, or the
presence of a driver. The runtime that will execute HY-MT2 is the authority on
whether CUDA is usable.

When CUDA is usable, the server starts with one selected device, automatic GPU
layer offload, and llama.cpp memory fitting enabled. The context remains bounded
to the application's existing translation requirement. Automatic fitting may
choose full or partial model offload according to available VRAM.

When CUDA is not usable, HY-MT2 starts directly on CPU. Twinscript does not
delay every CPU-only meeting with repeated accelerator retries; probe results
are cached for the application launch and invalidated only after a CUDA process
failure or an explicit readiness refresh.

## Startup and fallback state machine

HY-MT2 preparation follows this state sequence:

1. Verify the selected model and CPU runtime.
2. Probe the packaged CUDA runtime once for this app launch.
3. If usable, start HY-MT2 on CUDA with automatic fitting.
4. Wait for the existing bounded health check and read runtime device evidence.
5. If CUDA preparation fails, terminate that process completely and start the
   CPU runtime once.
6. If CPU preparation also fails, block the local translation stage with the
   existing actionable model/runtime error. Never switch to Luna implicitly.

A CUDA failure during an active meeting permits one controlled transition to
CPU for the same HY-MT2 model. Outstanding local translation requests are
invalidated by host generation and source revision. Authoritative final
translations are rescheduled on CPU; provisional work may be dropped. The app
does not transition back to CUDA until the next meeting or readiness refresh.

CPU fallback covers:

- no CUDA device reported;
- incompatible or missing driver support;
- incomplete or corrupt CUDA runtime files;
- process startup or health timeout;
- model allocation failure or insufficient VRAM;
- unexpected CUDA server exit;
- invalid device evidence.

The fallback is local and does not broaden privacy permissions.

## Truthful device and status reporting

HY-MT2 readiness and provenance report:

- `requestedDevice`: `CUDA_AUTO` or `CPU`;
- `actualDevice`: normalized runtime evidence such as `CUDA0` or `CPU`;
- `deviceName`: the bounded runtime-reported GPU name when available;
- `offload`: `full`, `partial`, `none`, or `unknown`;
- `fallbackReason`: a stable error code when CPU was selected after CUDA failed;
- `loadMs` and per-request `inferenceMs`.

The user-facing model card uses concise status:

- **NVIDIA GPU** for verified full CUDA offload;
- **NVIDIA GPU · partial offload** when runtime evidence proves partial offload;
- **CPU fallback** with an expandable reason when CUDA was attempted and failed;
- **CPU** on a machine where no usable packaged CUDA device exists.

The UI never labels execution as GPU based only on selection intent. If the
runtime cannot prove offload depth, it may say **NVIDIA GPU** but must not claim
full offload.

## Translation data flow and authority

The caption session manager and translation backend contracts remain unchanged.
They continue to send bounded HY-MT2 preview and final requests through the
hybrid local client. Runtime selection happens below that contract.

The selected final translation model always governs the saved result:

- HY-MT2 on CUDA and HY-MT2 on CPU are the same authoritative model choice.
- Falling back to CPU does not authorize Luna or any network request.
- A late result from a retired CUDA process is rejected by generation,
  utterance ID, and source revision.
- Provisional translation remains memory-only and cannot overwrite an
  authoritative final translation.

## Latency and quality behavior

GPU acceleration does not alter the HY-MT2 prompt, glossary matching,
protected-token handling, sampling temperature, quantized model, or maximum
output length. The same bilingual golden corpus must pass on CUDA and CPU.

Performance is evaluated at three layers:

- model `inferenceMs` returned by the local runtime;
- final translation latency from request dispatch to accepted response;
- user-visible latency from finalized source transcript to displayed final
  Chinese or English caption.

Warm CUDA execution must improve median model inference latency by at least 30
percent against the current CPU runtime on the release hardware and corpus.
It must not worsen p95 user-visible final-caption latency. If a particular
device does not meet the benefit threshold, that is recorded as engineering
evidence; correctness and safe fallback remain mandatory.

Chinese and English outputs must match the same quality gates used for the CPU
HY-MT2 path. CUDA output may differ in harmless surface form, but names,
numbers, units, protected tokens, matched glossary terms, and target-language
adequacy must not regress.

## Error handling

- Accelerator probing and startup have independent bounded timeouts.
- Process stderr is retained in a bounded diagnostic buffer and is not exposed
  verbatim in ordinary UI copy.
- CUDA allocation failure is recoverable through one CPU start.
- CPU fallback does not count as a model change and does not require user
  confirmation.
- If both runtimes fail, session startup fails closed when HY-MT2 is required as
  the final model. When HY-MT2 is only an optional preview accelerator, the
  selected Luna final path may continue.
- Runtime crashes never leave a listening loopback server, orphaned process, or
  stale model admission lock.
- Fallback codes are stable enough for automated tests and support diagnostics.

## Testing and release gates

Automated tests cover:

- CUDA device detected and selected automatically;
- no CUDA device starts CPU directly;
- corrupt or incomplete CUDA runtime starts CPU;
- CUDA startup timeout starts CPU after terminating CUDA;
- low-VRAM/model-allocation failure starts CPU;
- CUDA crash during a meeting invalidates old requests and retries final work
  once on CPU;
- CPU failure after CUDA failure returns the existing local translation error;
- runtime directories cannot cross-load backend libraries;
- actual device, offload state, fallback reason, and latency provenance survive
  the main-process and renderer boundaries;
- full-local privacy tests still observe no OpenAI credential, WebSocket, or
  HTTP client use;
- CPU and CUDA both pass EN-to-ZH and ZH-to-EN golden translation cases;
- all existing cloud/local model combinations preserve final-model authority.

Hardware validation uses the pinned release runtime and model on:

- an NVIDIA Ada laptop with sufficient free VRAM;
- the same machine under constrained VRAM to exercise partial offload or CPU
  fallback;
- a Windows machine with no NVIDIA GPU;
- a machine with an NVIDIA GPU but an incompatible or unavailable driver.

The production package must pass fresh UI, caption, local-inference, packaging,
signature, clean-install, and offline privacy suites. Device labels are checked
against runtime evidence rather than test stubs alone.

## Rollout

1. Pin and hash a CUDA-enabled llama.cpp runtime compatible with the existing
   HY-MT2 GGUF and Windows driver baseline.
2. Benchmark that runtime manually on the release machine without changing app
   selection logic.
3. Add runtime-family path resolution, integrity checks, and capability probes.
4. Add automatic CUDA selection and one-way CPU fallback behind a development
   feature flag.
5. Add provenance and status copy after main-process evidence is available.
6. Run quality, latency, VRAM-pressure, crash, privacy, packaging, and signing
   gates.
7. Enable automatic acceleration for Windows releases only after every gate
   passes. CPU remains the fallback in all enabled builds.

## Success criteria

The work is ready for user review when a local HY-MT2 session on compatible
NVIDIA hardware visibly reports verified GPU execution, produces correct final
Chinese and English captions, improves median warm inference latency by at
least 30 percent, and falls back to CPU without changing the selected model or
sending content to the cloud. The same build must remain fully functional on a
CPU-only Windows machine.
