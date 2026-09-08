# Installer Split and Verified Runtime Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an installer that carries no local inference payload, and let the operator install the local runtime from inside the app with one button that either succeeds or explains exactly why it did not. A released build must never present an install control that fails on an unreachable asset, a stale revision, or a missing manifest.

**Architecture:** Local runtimes become installable artifacts alongside the local models, reusing the machinery that already downloads and verifies models — signed catalog, per-file SHA-256, resumable ranged download, verified marker, verify/repair/remove. `forge.config.js` stops staging `local-inference-host` entirely, so the runtime root moves from a read-only packaged directory to a writable per-revision directory under `userData`, with the packaged path retained only as a development fallback. Every install control in the UI is driven by the same catalog the downloader uses, so a control is only offered when the asset behind it is described by the manifest that shipped.

**Tech Stack:** Electron 40 main process, Node.js CommonJS and `node:test`, React 19/TypeScript and Vitest, Electron Forge with Squirrel, PowerShell 5.1-compatible release scripts, GitHub release assets over HTTPS.

**Spec:** none; this plan is the specification.

---

## Measured current state

Taken from the 2026-09-07 build on this machine, not from memory.

| Item | Size |
| --- | ---: |
| `Twinscript-0.1.0 Setup.exe` | 866 MB |
| `resources/` in the packaged app | 1,411 MB |
| — `resources/local-inference-host` | 1,342 MB |
| — — `llama/cuda/ggml-cuda.dll` | 549 MB |
| — — `llama/cuda/cublasLt64_12.dll` | 452 MB |
| — — `llama/cuda/cublas64_12.dll` | 95 MB |
| — — OpenVINO DLLs (NPU compiler, CPU plugin, core, GenAI, tokenizers) | ~156 MB |
| — — `llama/cpu` and the host executable | ~70 MB |
| — `resources/app.asar` | 68 MB |

**No model weights are bundled.** Verified: no `.gguf`, no OpenVINO IR, no `.bin` over 10 MB anywhere in the package. Models already download at runtime. The 866 MB is almost entirely the CUDA acceleration runtime, so removing "the models" cannot shrink the installer — removing `local-inference-host` can.

Expected sizes after this plan: installer ~130 MB, CPU/NPU runtime bundle ~230 MB, CUDA pack ~1.1 GB.

## Measured result

From the 2026-09-08 build at `ea4f77bd`, measured the same way.

| Item | Before | After |
| --- | ---: | ---: |
| `Twinscript-0.1.0 Setup.exe` | 866 MB | **133 MB** |
| `resources/` in the packaged app | 1,411 MB | **70 MB** |
| — `resources/local-inference-host` | 1,342 MB | **absent** |

The runtime now ships as two archives fetched on demand:

| Archive | Download | Unpacked |
| --- | ---: | ---: |
| `twinscript-runtime-openvino-cpu-b9940.zip` (required) | 71 MB | 201 MB |
| `twinscript-runtime-cuda-b9940.zip` (optional) | 639 MB | 1,141 MB |

The estimate held: predicted ~130 MB, measured 133 MB. The CPU/NPU archive came
in well under the ~230 MB estimate because that figure was the unpacked tree;
compressed it is 71 MB, so the required download is smaller than planned.

Verified on the packaged app, not inferred: `local-inference-host` is absent, the
signed catalog is present and verifies with 2 models and 2 runtimes on the same
`packaged` path the app uses at runtime, and no private key or `.key` file is
anywhere in the package.

## Two blockers that make a release fail today

Both are verified, and both are the failure the goal names.

1. **The release the manifest points at does not exist.** Every file entry in `resources/local-models/model-manifest.json` carries a URL of the form
   `https://github.com/imperator28/Twinscript/releases/download/windows-local-beta/whisper-small-added_tokens.json`.
   `gh release view windows-local-beta` returns "release not found", and an anonymous `curl -L` of that URL returns **404**. The repository is also `PRIVATE`, so even once the release exists, an unauthenticated download from it will fail — the app has no credentials and must not acquire any. A user clicking Install today gets a failed download for every file.

2. **The manifest trio is uncommitted.** `resources/local-models/model-manifest.json`, `model-manifest.sig` and `model-manifest-public.pem` exist only on this machine. `loadLocalModelCatalog` requires all three when packaged; without them it returns `{ available: false, error: { code: 'local_catalog_unavailable' } }` and the UI says "Local model downloads are unavailable in this build." Unpackaged it silently falls back to `developmentLocalModelCatalog`, which is why local development never notices. A release built from a clean clone or CI therefore ships with local downloads disabled, and no test fails.

## Blocker status

- **Blocker 2 is resolved.** The trio is committed at `ea4f77bd`, and
  `scripts/local-model-release-assets.test.cjs` now fails the build if it is
  missing, unsigned, carries a non-HTTPS URL, offers no CPU runtime, or has
  private signing material beside it. The regenerated catalog also advertises
  both runtime archives; the version committed first advertised none, which
  would have left the engine button with nothing to fetch.
- **Blocker 1 is open, and is the last thing standing between this and a
  release.** The `windows-local-beta` release still does not exist: an attempt
  to create it with its assets failed on shell glob expansion, and `gh` rolls
  the release back when its asset upload fails, so no tag and no release remain.
  The repository is also still `PRIVATE`, so uploading the assets is necessary
  but not sufficient — anonymous download only starts working when the
  repository is public.

`scripts/verify-release-assets.cjs` is the gate for this and currently reports
22 of 22 unavailable. It checks anonymously on purpose: an authenticated check
would pass against a private release and then 404 for every real user, which is
exactly the failure being guarded.

## Hosting decision: make this repository public

**Chosen.** The assets are hosted on this repository's own releases, and the
manifest committed at `ea4f77bd` is signed against
`https://github.com/imperator28/Twinscript/releases/download/windows-local-beta/`.
Changing host now means regenerating and re-signing the catalog, so this is
settled rather than open.

The rejected alternatives, recorded so the choice is not revisited by accident:

- A dedicated public asset repository (`imperator28/twinscript-runtimes`) would
  have kept the source private, at the cost of a second repository and release
  step. Not needed once the source is public anyway.
- Object storage or a CDN gives the most control over bandwidth and retention,
  and costs setup and a bill.

The original framing of that decision follows, for the reasoning:

**Where the assets are hosted.** The app fetches anonymously over HTTPS and must keep doing so; adding a token to a shipped client is not an option. Three routes:

- **A dedicated public asset repository** (recommended), e.g. `imperator28/twinscript-runtimes`, holding only release assets. The application source stays private, assets are anonymously fetchable, and the manifest's `baseUrl` points there. Costs one repository and a release step.
- **Make this repository public.** Simplest, and makes AGPL-3.0 source availability moot, but publishes the source now.
- **Object storage or a CDN.** Most control over bandwidth and retention, most setup, and a bill.

Everything below is written so only the `baseUrl` handed to `scripts/prepare-local-model-release.cjs` changes between these. **Do not start Task 5 until this is chosen**, because the manifest that ships is signed against the chosen host.

## Fixed implementation decisions

- The installer contains **no** `local-inference-host`. `forge.config.js` stops staging it; the cloud pipeline is fully functional without any download.
- Two runtime bundles, not one, and not per-file downloads:
  - `twinscript-runtime-openvino-cpu-<revision>.zip` — OpenVINO GenAI, `llama/cpu`, `twinscript-local-inference.exe`, `runtime-manifest.json`.
  - `twinscript-runtime-cuda-<revision>.zip` — `llama/cuda` only, installed on top of the CPU bundle.
  A single archive per family keeps the 123-file inventory out of 123 HTTP requests, and the existing `runtime-manifest.json` verifies the extracted tree file by file afterwards.
- `revision` is the existing `runtimeFamilies.*.revision` value already in `runtime-manifest.json`. CPU and CUDA revisions must match, which `verifyRuntimeManifest` already enforces.
- Runtimes install to `userData/local-inference-host/<revision>/`. Per-revision directories make an upgrade additive and a rollback a directory switch, and mean a half-extracted upgrade can never shadow a working install.
- Resolution order for the runtime root: the newest installed revision whose manifest verifies, then the packaged `resources/local-inference-host` if present (development and any future bundled build), then none.
- `verifyRuntimeManifest` remains the only definition of "installed". A downloaded, extracted, unverified tree is not installed.
- The CUDA pack is never downloaded automatically. It is offered only when `llama-runtime-probe` reports a compatible NVIDIA device, and its absence is never an error — CPU translation is the supported default.
- Model download behaviour, the signature scheme (`crypto.verify` against the shipped public key), and the `local_catalog_unavailable` contract are unchanged. This plan extends the catalog; it does not redesign it.
- The signing private key never enters the repository, CI, or the app. Only `model-manifest-public.pem` ships.

## File and responsibility map

- `electron/captions/local-model-manifest.js`: extend the validated schema with a `runtimes` array (id, revision, family, archive URL, size, sha256, unpacked inventory reference). Signature covers it, since the signature is over the canonical JSON of the whole document.
- `electron/captions/local-model-manifest-loader.js`: unchanged contract; now also surfaces `runtimes`.
- `electron/captions/local-runtime-manager.js` **(new)**: download, extract, verify, remove a runtime bundle. Mirrors `LocalModelManager` — ranged resume, SHA-256 per file after extraction, verified marker, mutation mutex, progress events — and delegates the post-extraction check to `verifyRuntimeManifest`.
- `electron/captions/local-inference-paths.js`: resolve `runtimeRoot` from installed revisions under `userData` first, packaged path second.
- `electron/captions/local-inference-supervisor.js`: treat "runtime not installed" as an installable state rather than a dead end, and re-resolve paths after an install without an app restart.
- `electron/captions/local-model-service.js` and `register-caption-ipc.js`: expose runtime status and the install/verify/remove actions on the existing IPC surface, with the sender allowlist and `EVENT_CHANNELS` updated together.
- `electron/captions-preload.js`: the new channels, plus the allowlist entry. `electron/captions/preload-channels.test.cjs` already fails if the two lists disagree.
- `src/captions/LocalModelInstallCard.tsx`: one runtime row per family above the model rows, using the states the card already renders.
- `scripts/build-local-inference-host.ps1`: also emit the two archives and their SHA-256 values.
- `scripts/prepare-local-model-release.cjs`: include the runtime archives in the signed catalog alongside the models.
- `scripts/verify-release-assets.cjs` **(new)**: HEAD every URL in a candidate manifest and fail on anything that is not 200. This is the guard that makes "click Install and it works" checkable before publishing.
- `forge.config.js`: stop staging `local-inference-host`; keep staging `assets`, `resources` and the native camera.
- `.github/workflows/windows-release.yml`: run the asset check before publishing, and refuse to publish a build whose manifest trio is missing.

---

### Task 1: Make the missing manifest trio impossible to ship

The release-blocking half of blocker 2, fixed first because it is cheap and it currently hides itself.

- [x] Decide and record whether the trio is committed or generated at package time. Recommended: **commit** `model-manifest.json`, `model-manifest.sig` and `model-manifest-public.pem`. They are public verification artifacts, not secrets, and committing them makes a clean-clone build behave like this machine.
- [x] Add `scripts/local-model-release-assets.test.cjs`: the three files exist under `resources/local-models/`, the JSON parses, `loadManifest` accepts it against the committed public key with `packaged: true`, and every `files[].url` is HTTPS with a hostname.
- [x] Add a packaging assertion to `forge.config.js` (`packageAfterCopy`, beside `stageNativeCameraResources`) that throws if any of the three is absent from the copied resources. A missing manifest must fail the build, not the user's first click.
- [x] Extend `scripts/forge-local-inference-packaging.test.cjs` to assert that assertion exists and fires.

**Verification:** `npm run test:captions`. Then temporarily rename `model-manifest.sig`, confirm `npm run package` fails with a message naming the file, and restore it.

### Task 2: Resolve the runtime from a writable per-revision directory

- [ ] In `local-inference-paths.js`, add `installedRuntimeRoots({ userDataPath, fsImpl })` returning candidate `local-inference-host/<revision>` directories, newest revision first.
- [ ] Change `resolveLocalInferencePaths` to take the resolved `runtimeRoot` from the first candidate whose `runtime-manifest.json` verifies, then the packaged path, then `null`. Keep `executablePath`, `llamaCpuBinaryPath` and `llamaCudaBinaryPath` derived from whichever root won.
- [ ] Have the supervisor re-resolve paths on demand rather than only at construction, so an install takes effect without a restart.
- [ ] Tests in `local-inference-paths.test.cjs`: packaged with only a bundled root; packaged with one installed revision; two installed revisions (newest wins); an installed revision whose manifest fails verification (skipped in favour of the older one); nothing installed (`runtimeRoot: null`, no throw).

**Verification:** `node --test electron/captions/local-inference-paths.test.cjs electron/captions/local-inference-supervisor.test.cjs`.

### Task 3: Add the runtime manager

- [ ] Write `electron/captions/local-runtime-manager.js` with `status()`, `install(runtimeId)`, `verify(runtimeId)`, `remove(runtimeId)`, mirroring `LocalModelManager`'s shape and its `_withMutation` mutex so two installs cannot interleave.
- [ ] Download to `userData/local-inference-host/.staging/<runtimeId>-<revision>.zip` with ranged resume, verify the archive SHA-256 **before** extraction, extract to `.staging/<revision>/`, run `verifyRuntimeManifest` on the extracted tree, and only then rename into place. A failure at any step leaves the previous install untouched.
- [ ] Refuse to mutate while a session is active, reusing the existing `sessionActive` guard.
- [ ] Emit the same progress shape the model rows already render.
- [ ] Register the module in the `vite.config.ts` entry map. `main-build-entries.test.cjs` guards bare sibling requires but not `./captions/name`, so this is a manual step with a real consequence.
- [ ] Tests in `local-runtime-manager.test.cjs` with a fake fetch and fake fs: clean install; resumed partial download; archive hash mismatch (refused, nothing installed); extraction producing a tree that fails `verifyRuntimeManifest` (refused, previous install intact); install refused during a session; remove; CUDA installed on top of CPU.

**Verification:** `node --test electron/captions/local-runtime-manager.test.cjs`.

### Task 4: Carry runtimes through the catalog, IPC and preload

- [ ] Extend the manifest schema in `local-model-manifest.js` with `runtimes`, validated as strictly as `models`: HTTPS URL with hostname, safe relative paths, integer sizes, 64-character lowercase hex digests. Reject unknown families.
- [ ] Update `local-model-manifest.test.cjs` for accept and reject cases, including a runtime whose family is neither `cpu` nor `cuda`, and a CPU/CUDA revision mismatch.
- [ ] Surface runtime status through `local-model-service.js` and add the install/verify/remove handlers in `register-caption-ipc.js`, adding the HUD-style sender allowlist entry if a new window ever calls them.
- [ ] Add the channels to `captions-preload.js` **and** to `EVENT_CHANNELS` in the same edit. A subscribe helper whose channel is missing from that Set throws at runtime, and optional chaining does not help because the method exists — this has already cost one release-blocking bug.

**Verification:** `node --test electron/captions/local-model-manifest.test.cjs electron/captions/preload-channels.test.cjs electron/captions/local-model-ipc.test.cjs`.

### Task 5: Produce and publish the assets

Blocked on the hosting decision above.

- [ ] Extend `scripts/build-local-inference-host.ps1` to emit `twinscript-runtime-openvino-cpu-<revision>.zip` and `twinscript-runtime-cuda-<revision>.zip` from the already-staged tree, printing each archive's SHA-256.
- [x] Extend `scripts/prepare-local-model-release.cjs` to add the two archives to the signed catalog with the chosen `baseUrl`, keeping its existing refusal of non-HTTPS, credentialed, query-bearing or fragment-bearing URLs.
- [x] Write `scripts/verify-release-assets.cjs`: read a manifest, HEAD every `files[].url` and every runtime archive URL **anonymously**, and exit non-zero on anything other than 200. Report the first failing URL and its status.
- [ ] Publish the release and run the checker against the shipped manifest.

**Verification:** `node scripts/verify-release-assets.cjs resources/local-models/model-manifest.json` exits 0. Repeat from a machine or shell with no GitHub credentials — a token in the environment would mask exactly the failure this guards.

### Task 6: Remove the runtime from the installer

- [x] Drop `local-inference-host` from the staged resources in `forge.config.js`, leaving `assets`, `resources` and the native camera.
- [x] Update `scripts/forge-local-inference-packaging.test.cjs`: the package must contain the manifest trio and must **not** contain `local-inference-host`.
- [x] `npm run make`, then record the installer size and confirm `resources/local-inference-host` is absent.

**Verification:** installer measurably smaller (expected ~130 MB), `npm run smoke:packaged` passes, and the cloud pipeline runs end to end in the packaged app with no runtime installed.

### Task 7: One button, and an honest state for every outcome

The user-facing half of the goal. The card already renders `Ready`, `Verify` and `Remove`; runtimes join it as rows with the same vocabulary.

- [ ] Add a runtime row per family above the model rows in `LocalModelInstallCard.tsx`, showing size, revision, and the device it enables.
- [ ] Offer the CUDA row only when the probe reports a compatible NVIDIA device, and label its absence as optional rather than missing.
- [ ] Render each state below with copy that names the next action. No state may leave the operator with a control that cannot work.

| State | What the operator sees | Control |
| --- | --- | --- |
| Catalog missing from the build | This build cannot install local models or runtimes | none, and the reason is stated |
| Runtime not installed | Local pipelines need the runtime, with its size | Install |
| Downloading | Percentage and bytes, cancellable | Cancel |
| Download failed, network | Could not reach the download, with retry | Retry |
| Download failed, 404 or 403 | The release asset is unavailable for this version | Retry, and the version is shown |
| Archive hash mismatch | Download did not match its signature; nothing was changed | Retry |
| Extracted tree fails verification | Install incomplete; previous runtime still in use | Repair |
| Installed but revision older than the manifest | Update available | Update |
| Installed and verified | Ready | Verify, Remove |
| Session active | Runtimes cannot change during a meeting | disabled, with the reason |

- [ ] Renderer tests in `LocalModelInstallCard.test.tsx` for each row state, asserting the control offered and that no state renders an enabled control with nothing behind it.
- [ ] Assert the 404 case explicitly: a manifest whose asset returns 404 must surface "unavailable for this version", not a generic failure. This is the reported failure mode, and it is the one most likely to reach a user.

**Verification:** `npm test`, plus a manual pass with the network disabled, then with a deliberately wrong URL in a local manifest copy.

### Task 8: Guard the release

- [ ] Add `verify-release-assets.cjs` to `windows-release.yml` before publishing, and fail the job on a non-200.
- [ ] Fail the job if the manifest trio is absent from the packaged resources.
- [ ] Record in `docs/windows/signing.md` (or a new `docs/windows/local-runtime-release.md`) the order: build host → emit archives → publish assets → prepare signed catalog → verify assets anonymously → package installer.

**Verification:** a dry run of the workflow on a branch, with a deliberately broken URL, fails at the asset check rather than at publish.

### Task 9: End-to-end validation on a clean machine

The only test that covers the reported failure completely.

- [ ] Install the new installer on a Windows machine with no `%APPDATA%\Twinscript` and no models.
- [ ] Confirm the cloud pipeline captions a meeting with nothing downloaded.
- [ ] Switch to a local pipeline, click Install on the runtime row, and confirm it downloads, verifies, and becomes Ready without a restart.
- [ ] Install Whisper and HY-MT2 from their rows; confirm a local session captions correctly, and that the English column reads English.
- [ ] On an NVIDIA machine, install the CUDA pack and confirm the acceleration status reports CUDA.
- [ ] Remove the runtime and confirm the app returns to the not-installed state rather than erroring.
- [ ] Record the evidence under `docs/windows/evidence/`.

**Verification:** every step above, on hardware that has never run a development build. A machine with `artifacts/local-inference-host` present would resolve the packaged fallback and prove nothing.

---

## Failure modes this plan is designed against

Each is a way "click the button" turns into an obscure module-load failure, which is what the goal forbids.

- **Asset unreachable** — private repository or missing release. Task 5's anonymous checker and Task 8's release gate catch it before publish; Task 7 names it if it still happens.
- **Manifest absent from the build** — Task 1 turns it into a build failure instead of a disabled feature.
- **Manifest present, assets from a different revision** — the revision is part of the archive name, the install directory, and the runtime manifest; a mismatch reports Update, not a broken load.
- **Half-extracted install** — staged then renamed, so a failure leaves the previous revision serving.
- **Corrupt download** — archive digest checked before extraction; file digests after.
- **Family mismatch** — `verifyRuntimeManifest` already requires equal CPU and CUDA revisions and the declared entry points.
- **Install during a session** — refused with the reason, reusing the existing guard.
- **Disk exhaustion mid-download** — staging directory checked against the declared size before starting; the error names the shortfall.
- **The app looks for the runtime where the installer used to put it** — Task 2's resolution order, with tests for each branch.

## Risks

- **The CUDA pack is 1.1 GB.** Nothing here makes it smaller; it makes it optional and explicit. If that download is unacceptable, the alternative is dropping CUDA support, which is a product decision and not part of this plan.
- **Hosting choice is load-bearing and irreversible per release.** The manifest is signed against the URLs it carries, so moving hosts later means re-signing and re-publishing.
- **`resources/local-models` is a name collision waiting to happen**: the models live in `userData/local-models`, and the manifest describing them ships in `resources/local-models`. Worth renaming the shipped directory in a separate change; renaming it inside this one would obscure the diff that matters.
- **A test-only escape hatch is tempting.** Do not add an environment variable that skips verification. The verification is what makes the download safe to click.

## Final self-review checklist

- [ ] The installer contains no `local-inference-host` and the cloud pipeline works with nothing downloaded.
- [ ] Every URL in the shipped manifest returns 200 to an anonymous request, checked by a script in the release job.
- [ ] The manifest trio cannot be missing from a package without failing the build.
- [ ] Every row state in Task 7's table is covered by a renderer test, including 404.
- [ ] Installing a runtime takes effect without restarting the app.
- [ ] A failed or partial install leaves the previous runtime serving.
- [ ] `npm test`, `npm run test:captions`, the native host suite, and `npm run smoke:packaged` all pass, and `tsc --noEmit` adds no errors against the recorded baseline.
- [ ] Task 9 was performed on a machine that has never run a development build.
