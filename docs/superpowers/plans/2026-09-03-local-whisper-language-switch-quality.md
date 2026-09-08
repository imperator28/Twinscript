# Local Whisper Language-Switch Quality Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore enough phrase context for reliable Whisper Small automatic language identification while keeping bilingual switching responsive.

**Architecture:** Keep the existing JavaScript VAD, native Whisper pipeline, provisional decode cadence, and repetition protection. Change only the native local-Whisper utterance gate from 250 ms / 3 seconds to 500 ms / 12 seconds, with regression tests pinning both boundaries.

**Tech Stack:** C++20, Catch2, CMake/CTest, OpenVINO GenAI, Electron Forge, PowerShell

---

### Task 1: Protect the quality-first phrase boundary

**Files:**
- Modify: `native/local-inference-host/tests/audio_segmenter_test.cpp`
- Modify: `native/local-inference-host/src/audio_segmenter.cpp`

- [x] **Step 1: Write the failing quiet-boundary test**

Replace the existing local phrase-boundary test with assertions that 250 ms and 500 ms minus one frame do not finalize, while 500 ms or more does:

```cpp
TEST_CASE("local Whisper gate retains context through short pauses") {
  auto gate = twinscript::make_local_whisper_utterance_gate();
  REQUIRE_FALSE(gate.observe(std::vector<std::int16_t>(24000, 1200)).finalize);
  REQUIRE_FALSE(gate.observe(std::vector<std::int16_t>(6000, 0)).finalize);
  REQUIRE_FALSE(gate.observe(std::vector<std::int16_t>(5999, 0)).finalize);
  REQUIRE(gate.observe(std::vector<std::int16_t>(1, 0)).finalize);
}
```

- [x] **Step 2: Write the failing continuous-context test**

Replace the three-second test with a test that remains open through 11 seconds and finalizes at 12:

```cpp
TEST_CASE("local Whisper gate periodically refreshes language with useful context") {
  auto gate = twinscript::make_local_whisper_utterance_gate();
  twinscript::UtteranceDecision decision;
  for (int second = 0; second < 11; ++second) {
    decision = gate.observe(std::vector<std::int16_t>(24000, 1200));
    REQUIRE_FALSE(decision.finalize);
  }
  decision = gate.observe(std::vector<std::int16_t>(24000, 1200));
  REQUIRE(decision.append);
  REQUIRE(decision.finalize);
}
```

- [x] **Step 3: Run the focused test and verify RED**

Run:

```powershell
cmake --build native/local-inference-host/build --config Release --target local_inference_tests
ctest --test-dir native/local-inference-host/build -C Release --output-on-failure -R "local Whisper gate"
```

Expected: both updated tests fail because the current gate finalizes at 250 ms or 3 seconds.

- [x] **Step 4: Implement the minimal gate change**

Update `make_local_whisper_utterance_gate()`:

```cpp
UtteranceGate make_local_whisper_utterance_gate() {
  // Keep short pauses inside one phrase so Whisper has enough context for
  // multilingual identification. Refresh after twelve seconds of continuous
  // speech so a code-switch can still be reconsidered without a pause.
  return UtteranceGate{24000, 0.001, 500, 12000};
}
```

- [x] **Step 5: Run the focused test and verify GREEN**

Run the commands from Step 3. Expected: all matching tests pass.

- [x] **Step 6: Commit the regression fix**

```powershell
git add native/local-inference-host/tests/audio_segmenter_test.cpp native/local-inference-host/src/audio_segmenter.cpp
git commit -m "fix: restore Whisper phrase context"
```

### Task 2: Rebuild and validate the beta

**Files:**
- Rebuild: `artifacts/local-inference-host/twinscript-local-inference.exe`
- Rebuild: `out/Twinscript-win32-x64/`

- [x] **Step 1: Run native and policy tests**

```powershell
ctest --test-dir native/local-inference-host/build -C Release --output-on-failure
npm run test:captions
```

Expected: zero failures.

- [x] **Step 2: Rebuild the OpenVINO GenAI sidecar**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-local-inference-host.ps1 -Configuration Release -OpenVinoRoot "C:\Users\<user>\AppData\Local\Temp\twinscript-openvino-genai-2026.3-rebuild\expanded\openvino_genai_windows_2026.3.0.0_x86_64" -OutputDirectory artifacts/local-inference-host -LlamaCpuRoot artifacts/local-inference-host/llama/cpu -LlamaCudaRoot artifacts/local-inference-host/llama/cuda
```

Expected: the Release native host and Whisper smoke target compile and native tests pass.

- [x] **Step 3: Run the installed-model NPU smoke**

Run `scripts/smoke-local-inference.cjs` with the installed Whisper Small and HY-MT2 model paths, NPU device, repository test audio, and an existing writable cache directory. Expected: the JFK English transcript, device `NPU`, HY-MT2 output preserving `24 VDC`, and inference faster than audio duration.

- [x] **Step 4: Package and smoke the Electron app**

```powershell
npm run package
npm run smoke:packaged
```

Expected: packaging and packaged lifecycle smoke both exit successfully.

- [x] **Step 5: Restart the packaged beta**

Close only Twinscript processes whose executable path is the worktree package, launch `out/Twinscript-win32-x64/twinscript.exe`, and verify the visible window is responding.

- [ ] **Step 6: User validation**

Speak one complete English phrase, switch to Chinese, then switch back to English. Confirm no Swedish or other unrelated-language fragments, no missing first words, and no local-transcription queue warning.
