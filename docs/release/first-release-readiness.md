# First macOS and Windows release readiness

This branch produces internal candidates, not a stable release. The unified
`build.yml` runs tests and packages macOS arm64/x64 and Windows x64, with unpacked
secret scanning and real control-window-close smoke tests. Windows reports all
shipped signature targets, including the DirectShow DLL. macOS uses ad-hoc signing;
no Apple Developer membership or notarization is assumed. Artifacts explicitly
state internal-only. The candidate workflow cannot publish, tag or merge.

Local Linux tests/build are regression evidence only. GitHub runner smoke tests
must pass for the exact candidate SHA; then test the downloaded artifacts on real
machines. CI does not establish microphone, loopback or camera compatibility.

## Real-device checklist

Record candidate SHA, artifact checksum, OS/architecture, client versions and
redacted results. Use consented scripted audio, never private meetings in CI.

- macOS arm64 and Intel: launch downloaded app, approve microphone/system capture,
  verify separate mic/system captions and consent handling; restart and confirm
  API keys remain in secure storage without recurring unexpected Keychain prompts.
  Drag/close overlays, verify always-on-top, high-contrast stacked/side-by-side
  panels, 3–10 complete history entries growing upward, and both audience languages
  during code switching. Use OBS virtual camera and test meeting-client selection.
- Windows 11 x64: standard-user Squirrel install/update/uninstall; UAC approval and
  cancellation; DirectShow registration and frame publication in Teams, Slack,
  Chrome and Zoom. Check missing/versioned/loaded DLL removal, unrelated-camera
  preservation and idempotence. Loaded DLL cleanup must fail visibly, preserve
  files, and succeed after consumers close. Never revive the old MF camera host.
- Both: verify dimensions, numbers, glossary tokens, final-caption stability,
  interruption/reconnect, API failure/budget exhaustion and close during speech.
  On Windows confirm closing control exits all app/capture processes. On macOS
  confirm control-close keeps the Dock app as designed and native Quit ends all
  app/capture processes.
- Both: run a 30–60 minute meeting; confirm autosaved transcript, readable records,
  backup/restore/export, crash recovery and stop/drain behavior against approved
  specs. Record dropped audio, errors, latency basis and actual cost.

Public distribution remains blocked on device acceptance plus an explicit signing
policy: Windows publisher signatures (including native DLLs) and the macOS
Gatekeeper/notarization distribution decision. Ad-hoc or unsigned candidate
success must never be recorded as public-release readiness.

See [model evaluation](model-evaluation.md) for source-verified prices and the
remaining paired model/ASR evidence. No paid evaluations ran in this session.

## Records corrections from the release audit

Recovery now preserves all unanswered encrypted audio decisions, matching the
approved July 30 records spec; it no longer deletes older audio at a five-meeting
threshold. Previously expired audio cannot be recovered by this change. Disk use
can grow until the operator chooses Keep/Delete, as the approved policy requires.
Audio decisions remain separate from starting the next session.

Transcript append failures now emit a visible degraded status and persist an
incomplete-record count in the pending manifest, including through crash recovery.
Later successful writes do not turn that record into a false "transcript saved"
claim. The review also distinguishes explicitly disabled transcript auto-save.
These changes report storage failures; they cannot recover a caption that the
storage device refused to write. Real disk-full/disconnect acceptance remains on
the platform checklist.

The DirectShow installer also carries the requesting operator SID through UAC and
grants that user Modify on frame-runtime data only. Supplying another admin's
credentials must not leave the normal app unable to publish frames. Windows CI
checks real NTFS ACLs and rejects malformed SIDs and redirected runtime folders;
full standard-user install/capture/update/uninstall acceptance still requires the
real-device checklist.
