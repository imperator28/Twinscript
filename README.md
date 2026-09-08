<p align="center">
  <img src="assets/icon.png" alt="Twinscript" width="104" height="104">
</p>

<h1 align="center">Twinscript 会意</h1>

<p align="center">
  Private, realtime English–Chinese subtitles for bilingual engineering meetings.
</p>

Twinscript listens to a meeting on the operator's own machine and produces two
audience views of it — English and Simplified Chinese — either as always-on-top
overlays or as a virtual camera that other apps can join like any webcam.

It runs no server of its own. Nothing is collected, and no analytics or
telemetry is initialised anywhere in the app. Depending on which pipeline you
choose, either `api.openai.com` is the single host contacted, or nothing leaves
the machine at all.

## What it does

- **Two capture channels, kept separate.** The microphone and the meeting's own
  output are transcribed independently, so a remote speaker is never attributed
  to the operator.
- **Cloud or fully local processing.** Either OpenAI's realtime models, or
  Whisper and a translation model running on your own CPU, Intel NPU or NVIDIA
  GPU. The local pipeline needs no API key and no network.
- **Two audience surfaces.** Overlays for in-room screens, or a virtual camera
  for remote participants. On Windows the camera is a DirectShow filter this
  project implements; it is installed on demand from Settings and asks for
  administrator approval once.
- **A glossary that reaches the model** — one-to-one term pairs, phrases to leave
  untranslated, and contextual notes such as attendee names — all editable in
  place.
- **Cost control.** A per-session budget, live spend against it, and a one-press
  raise mid-meeting.
- **Meeting records.** Audio is held encrypted and only becomes playable if you
  choose Keep; undecided meetings are asked about together, capped at the five
  most recent.

## Getting it

There is no published installer yet. Build it from source:

```bash
npm install
npm run make
```

That writes a Windows installer to `out/make/`. `npm run make` packages for
whichever platform you run it on.

## Choosing a pipeline

Both are selected in Settings, and either can drive the overlays or the virtual
camera.

**Cloud.** Realtime transcription and translation through OpenAI
`gpt-live-transcribe` over a WebSocket session, with a caption-responsiveness
setting that trades latency against how often a line is revised. Needs an API
key.

The key is stored by the operating system's credential store (DPAPI on Windows,
Keychain on macOS) and is never written to the repository, a dotfile, or a
`VITE_` variable — anything prefixed `VITE_` is inlined into renderer JavaScript
and would ship with the app. See [safe API key setup](docs/security/api-key-setup.md).

**Local.** Speech recognition and translation on the machine, with no key and no
network. Windows only. The installer does not carry the engine or the models, so
they are downloaded on demand from Settings the first time you choose this
pipeline:

| | Download | Runs on |
| --- | ---: | --- |
| Processing engine | 71 MB | CPU, or an Intel NPU where present |
| NVIDIA acceleration | 639 MB | optional; offered only if a compatible GPU is detected |
| Whisper Small — speech recognition | ~240 MB | MIT |
| HY-MT2 1.8B — English–Chinese translation | ~1.1 GB | Apache-2.0 |

Every download is checked against a signed catalog that ships inside the
installer: each file is verified by SHA-256 before it is used, and a failed or
partial install leaves whatever was working before untouched.

## Develop

```bash
npm install
npm run dev
```

`npm run dev` starts Vite **and** launches Electron — there is no separate start
step, and stopping Electron stops the dev server with it.

```bash
npm test               # renderer and shared logic (Vitest)
npm run test:captions  # main process and native host (node:test)
npm run build
```

The two suites deliberately do not overlap: Vitest owns `.ts`/`.tsx`, node:test
owns `.cjs`. A file picked up by both would run under the wrong environment.

## Platforms

| | Status |
| --- | --- |
| Windows 11 x64 | Primary target. Overlays, local processing, and the DirectShow virtual camera. |
| macOS | Capture, overlays and the screening runner. No virtual camera, no local processing. |

## Validation

A deterministic 256-prompt screening corpus lives in
`src/captions/screeningCorpus.ts` and runs with `npm run w1:corpus`. Half the
prompts code-switch, and 240 carry a critical number, unit, date, ID, material or
finish — the things a bilingual engineering meeting cannot afford to have
paraphrased.

- [Safe API key setup](docs/security/api-key-setup.md)
- [Screening corpus manifest](docs/validation/phase-1/corpus-manifest.md)
- [Sokuji reuse map](docs/architecture/sokuji-reuse-map.md)

## License and attribution

Licensed under [AGPL-3.0](LICENSE). Forked from Sokuji v0.34.5, whose audio
capture and window handling this app keeps. Runs on Electron, React, Vite and
TypeScript; cloud captions come from OpenAI's realtime speech-to-text and
translation models; local processing uses OpenVINO GenAI and llama.cpp; icons by
Lucide. The Windows virtual camera is an independent DirectShow filter written
for this app, not derived from any existing virtual camera.

The same attribution appears in the app under Settings → About, and its wording
is asserted against `package.json` by `src/captions/aboutCredits.test.ts` so the
two cannot drift.

Designed by Jiyu.
