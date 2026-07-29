# Sokuji reuse map

Upstream foundation:
`0808d3b7aba613a5e58b97a6804e8730e706bd93` (Sokuji v0.34.5).

| Subsystem | Decision | Phase 1 implementation |
| --- | --- | --- |
| Electron, React, Vite, Forge | Keep | Existing toolchain and packaging retained |
| `ModernAudioRecorder` | Adapt | 24 kHz PCM microphone capture feeds a narrow audio IPC |
| `LoopbackRecorder` | Adapt | 24 kHz meeting/system stream remains a separate channel |
| macOS/Windows audio utilities | Keep | Reused behind the caption-only main process |
| Subtitle window mechanics | Replace surface, keep pattern | Two solid always-on-top audience windows |
| Provider orchestration | Replace | Main-process `gpt-live-transcribe` sessions and Responses normalization |
| Renderer API-key settings | Replace | Status-only preload API; Keychain/DPAPI-backed ciphertext |
| Voice generation/TTS | Exclude from product path | No synthesized audio or virtual microphone |
| Hosted auth/analytics | Exclude from product path | Caption entry point does not initialize either |
| Multi-provider settings UI | Exclude from product path | Three explicit OpenAI normalization profiles |
| Existing eval runner | Supplement | In-app live shadow comparison plus encrypted replay |
| Browser extension | Exclude from release path | Desktop app is the validation and final-client base |

The retained source remains in the ancestry to make future capture fixes
cherry-pickable. The shipped application starts from
`electron/captions-main.js`, so unrelated Sokuji voice and account flows are
not reachable from the product UI.
