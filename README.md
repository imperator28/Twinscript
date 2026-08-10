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

Audio and transcripts stay on the machine apart from the transcription request
itself. `api.openai.com` is the only host the caption process contacts — the
upstream fork's hosted auth and analytics are not reachable from any caption
surface, and this project runs no server of its own.

## What it does

- **Two capture channels, kept separate.** The microphone and the meeting's own
  output are transcribed independently, so a remote speaker is never attributed
  to the operator.
- **Realtime transcription and translation** through OpenAI
  `gpt-live-transcribe` over a WebSocket session, with a caption-responsiveness
  setting that trades latency against how often a line is revised.
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

## Run

```bash
npm install
npm run dev
```

`npm run dev` starts Vite **and** launches Electron — there is no separate start
step, and stopping Electron stops the dev server with it.

An OpenAI API key is required; there is no offline or demo mode. The key is
stored by the operating system's credential store (DPAPI on Windows, Keychain on
macOS) and is never written to the repository, a dotfile, or a `VITE_` variable —
anything prefixed `VITE_` is inlined into renderer JavaScript and would ship with
the app. See [safe API key setup](docs/security/api-key-setup.md).

## Tests

```bash
npm test              # renderer and shared logic (Vitest)
npm run test:captions # main process (node:test)
npm run build
```

The two suites deliberately do not overlap: Vitest owns `.ts`/`.tsx`, node:test
owns `.cjs`. A file picked up by both would run under the wrong environment.

## Platforms

| | Status |
| --- | --- |
| Windows 11 x64 | Primary target. Overlays and the DirectShow virtual camera. |
| macOS | Phase 1 build: capture, overlays, and the screening runner. No virtual camera. |

## Validation

A deterministic 256-prompt screening corpus lives in
`src/captions/screeningCorpus.ts` and runs with `npm run w1:corpus`. Half the
prompts code-switch, and 240 carry a critical number, unit, date, ID, material or
finish — the things a bilingual engineering meeting cannot afford to have
paraphrased.

Planning and setup:

- [Windows client handoff](docs/windows/README.md)
- [Phase 0 and Phase 1 implementation plan](docs/superpowers/plans/2026-07-29-phase-0-and-phase-1-implementation-plan.md)
- [macOS validation guide](docs/validation/phase-1/validation-guide.md)
- [Screening corpus manifest](docs/validation/phase-1/corpus-manifest.md)
- [Current architecture decision](docs/validation/phase-1/architecture-decision.md)
- [Safe API key setup](docs/security/api-key-setup.md)
- [Sokuji reuse map](docs/architecture/sokuji-reuse-map.md)

## License and attribution

Licensed under [AGPL-3.0](LICENSE). Forked from Sokuji v0.34.5, whose audio
capture and window handling this app keeps. Runs on Electron, React, Vite and
TypeScript; captions come from OpenAI's realtime speech-to-text and translation
models; icons by Lucide. The Windows virtual camera is an independent DirectShow
filter written for this app, not derived from any existing virtual camera.

The same attribution appears in the app under Settings → About, and its wording
is asserted against `package.json` by `src/captions/aboutCredits.test.ts` so the
two cannot drift.

Designed by Jiyu.
