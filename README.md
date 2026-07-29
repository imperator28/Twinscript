# Bilingual Meeting Captions

Private, realtime English–Chinese subtitles for bilingual engineering meetings.

The macOS Phase 1 build includes separate microphone and meeting capture,
`gpt-live-transcribe`, two audience-specific overlays, primary/shadow
normalization profiles, cost controls, and opt-in encrypted replay.

## Run

```bash
npm install
npm run dev
```

Use **Demo Session** without an API key. For live mode, follow the safe key
instructions below; never add a key to a `VITE_` variable.

Planning and setup:

- [Phase 0 and Phase 1 implementation plan](docs/superpowers/plans/2026-07-29-phase-0-and-phase-1-implementation-plan.md)
- [macOS validation guide](docs/validation/phase-1/validation-guide.md)
- [Safe API key setup](docs/security/api-key-setup.md)
- [Sokuji reuse map](docs/architecture/sokuji-reuse-map.md)
