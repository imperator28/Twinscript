# One-click local setup and Windows executable

The user approved installing only missing models required by their selected pipeline. The deliverable is a Windows Setup.exe that installs Twinscript and a Start menu shortcut; opening Twinscript must not require Node, Python, a terminal, or model folder management.

## Setup behavior

Settings offers Install missing model(s), naming only required models that are not ready. Fully cloud configurations require none. Whisper is required for local transcription. HY-MT2 is required for local final translation or enabled early local translation. Existing ready models are skipped. Separate per-model controls remain available.

Installation runs sequentially with existing progress and verification events. The first failure stops the queue and displays an error. A retry uses the existing resumable download manager. Installation does not change pipeline choices. Meeting admission continues to block model mutations during sessions.

## Distribution requirements

Bundle the verified native host, OpenVINO libraries, and pinned llama CPU/CUDA runtime families in the Windows app. Ship an authenticated catalog with reachable HTTPS URLs and the exact file hashes of the validated Whisper export and HY-MT2 GGUF. Preserve version identifiers where the bytes match existing installations. Users must not need a model-host account or a developer tool.

The current beta catalog marks both models localOnly and uses local.invalid URLs. This is not a downloadable release. Do not enable automatic install for this catalog. The previous feature worktree's generated native host and model metadata were removed during merge cleanup; rebuild them before producing a replacement executable. The older executable currently under out lacks the local inference runtime and must not be handed off as this release.

## Acceptance

- A fresh Windows user can run Setup.exe and open Twinscript from its shortcut.
- One click downloads only the missing selected model(s), verifies them, and reports readiness.
- Existing verified models survive application updates without another download.
- Interrupted transfers can retry; corrupted files are not marked ready.
- Clean package validation does not depend on developer-local model metadata.
- Validate a real download and local session from an isolated user-data directory before calling this ready for new users.
