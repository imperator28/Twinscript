# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

This file used to describe Sokuji — a multi-provider translation app with OpenAI,
Gemini, Palabra.ai and Kizuna AI clients, a `ClientFactory`, Zustand stores, a
35-language i18next UI and a browser extension. None of that is in this repository
any more, and most of it was already unreachable while the description was still
here. Treating it as current sent work to files the app never loads.

## What this project is

**Twinscript** (会意) is a Windows-first Electron desktop app that puts realtime
English and Simplified Chinese captions on a bilingual engineering meeting. Audio
is captured locally, transcription and translation go to OpenAI, and the result is
shown either as always-on-top overlays or through a virtual camera that other apps
join like a webcam.

One provider, one model, no hosted backend of its own. `api.openai.com` is the only
host the caption process contacts.

## Where the code is

Everything the app loads is reachable from three entry points:

| Entry | What it is |
| --- | --- |
| `electron/captions-main.js` | Main process. `package.json`'s `main` points at its build output. |
| `electron/captions-preload.js` | The `window.captions` bridge. Its types live in `src/electron.d.ts`. |
| `index.html` → `src/main.tsx` → `src/App.tsx` | Renderer. Picks a surface from `?surface=`. |

- `electron/captions/` — main-process subsystems: session manager, window manager,
  settings store, credential store, meeting records, cost meter, camera transport.
- `src/captions/` — every renderer surface and all its logic. This is the UI.
- `src/lib/modern-audio/` — capture: `ModernAudioRecorder`, `LoopbackRecorder`, and
  the GTCRN noise-suppression worker.
- `native/camera-companion/` — the Windows DirectShow virtual camera (C++).
- `shared/caption-themes.json` — theme definitions read by both processes.

Three renderer surfaces, selected by query parameter: `control` (the operator
window), `caption` (an audience overlay), `camera-stage` (the frame source for the
virtual camera).

## Retained but not reachable

`src/lib/local-inference/`, `sidecar/`, `model-packs/`, `public/workers/` and the
sherpa-onnx / piper / vad WASM under `public/wasm/` are a local ASR/TTS/translation
stack kept deliberately as a possible future path. **Nothing in the app reaches
them.** Do not wire them into a caption path without being asked.

One exception, and it matters: `src/lib/local-inference/workers/_shared/onnxruntime-all.ts`
**is** live. `gtcrn-worker.ts` imports it for microphone noise suppression, which is
why `ort` and `gtcrn` are the only two WASM directories `forge.config.js` packages.

## Commands

```bash
npm run dev           # Vite AND Electron — see the traps below
npm test              # renderer (Vitest, src/captions/**/*.test.{ts,tsx})
npm run test:captions # main process (node:test, *.test.cjs)
npm run build
npm run make          # package for the current platform
npm run w1:corpus     # 256-prompt screening corpus
```

## Traps that have each cost real time

- **`npm run dev` launches Electron itself** through `vite-plugin-electron`'s
  `onstart`. There is no separate start step, and killing Electron kills the dev
  server. Launch it detached if it must outlive the shell that started it.
- **The main-process build entry map in `vite.config.ts` is hand-maintained.** A
  module required from a sibling as `./name` must also be listed there or it is
  never emitted, and the app dies at launch with `Cannot find module './name'`.
  `electron/captions/main-build-entries.test.cjs` guards bare sibling requires —
  but not `./captions/name`, which rolldown inlines instead.
- **`assets/` is not in the asar.** It ships via `extraResource` to
  `process.resourcesPath/assets`, so no single relative path finds it both packaged
  and unpackaged. See `electron/captions/app-icon.js`, and never resolve it from
  `__dirname`.
- **Never put a secret behind `VITE_`.** Anything so prefixed is inlined into
  renderer JavaScript and ships. Keys live in the OS credential store via
  `safeStorage`.
- **The OpenAI `delay` parameter accepts more values than are usable.** Only
  `minimal`, `low` and `medium` are offered; `high` and `xhigh` delay captions past
  the point of being live, and `'default'` is rejected outright. The API accepting a
  value is not evidence it belongs in the UI.
- **The virtual camera CLSID must never change.** A new one orphans every
  previously registered camera.
- **The two test suites do not overlap on file extension**, deliberately. Vitest
  owns `.ts`/`.tsx`, node:test owns `.cjs`. A file matched by both runs under the
  wrong environment.
- **`tsc --noEmit` is not clean.** Compare the error count before and after a
  change rather than expecting zero.

## Commit identity (do not skip)

This repository is public. The author and committer of every commit are published
with it, permanently and in every fork, so an address cannot be un-published once
pushed.

- **Never commit with a work or employer address**, and never with a
  machine-local one (`*.local`). Use
  `imperator28@users.noreply.github.com`.
- `.githooks/pre-commit` refuses any commit whose author or committer email
  matches an employer, `*.local`, `*.internal` or `*.corp` address. It reads the
  identity git is actually about to use, so a global config or a
  `-c user.email=...` override cannot slip past it.
- A fresh clone must run this once, or the hook is not active:

```bash
sh scripts/setup-repo-hooks.sh
```

- Do not pass `--no-verify` to get around it. If the hook fires, the address is
  wrong; fix the address.
- This client initializes no analytics or telemetry. `api.openai.com` is the only
  host the caption process contacts. Do not add an analytics dependency, event,
  or environment variable without being asked - several inherited documents used
  to describe telemetry this app never had, and they have been removed.

## Conventions

- English only in comments, commits and docs.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- TypeScript strict; `src/lib/modern-audio/` is JavaScript by inheritance.
- Comments explain **why**, and earn their place where code looks wrong but isn't.
- Settings changes need a `settingsVersion` bump and a migration in
  `electron/captions/settings-store.js`, which normalizes on read *and* write.

## Release

All version sites must land in one `chore(release): vX.Y.Z` commit **before** the
tag, because the release workflow checks out the tag verbatim. There are two:
`package.json` and `package-lock.json`. `scripts/release/tag-version.js` owns the
list and a test pins it, so a third site appearing without the tooling knowing is
caught rather than discovered after a bad release.

```bash
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin main --follow-tags
```

## Provenance

Forked from Sokuji v0.34.5 (`0808d3b7`) and licensed under AGPL-3.0. See
`docs/architecture/sokuji-reuse-map.md`. The DirectShow virtual camera is a
clean-room implementation: no code from OBS or any other virtual camera is in this
repository, and none may be added — OBS is GPL-2.0 and was used only as a consumer
to validate against.

## Git worktrees

Worktree directory: `.claude/worktrees/` (gitignored).
