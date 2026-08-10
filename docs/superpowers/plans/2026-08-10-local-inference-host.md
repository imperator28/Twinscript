# Local Inference Host Implementation Plan

> **Implementation note (2026-08-10):** Feasibility changed the translation adapter,
> without changing the protocol or application boundary. The production supervisor now
> runs the C++ OpenVINO GenAI host for Whisper on `NPU` and a private loopback
> `llama-server` process for Hy-MT2 on `CPU`. `HybridLocalInferenceClient` presents both
> processes behind protocol v1. The OpenVINO Hy-MT2 adapter described in Task 5 is not
> implemented because the `hunyuan_v1_dense` architecture could not be exported by the
> validated OpenVINO toolchain. See the feasibility report for the exact revisions,
> hashes, and measurements.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained Windows native process that serves bounded Whisper ASR and Hy-MT2 translation requests using the device allocation proven by the feasibility plan.

**Architecture:** A C++ executable owns the OpenVINO GenAI Whisper pipeline and exposes a versioned JSON-lines protocol over stdin/stdout. A supervised loopback llama.cpp server owns Hy-MT2 translation. Engine interfaces and fake implementations make protocol, cancellation, priority, and lifecycle behavior testable without model weights; hardware adapters are added only after the contract is stable.

**Tech Stack:** C++20, CMake 3.20+, Visual Studio 2022, OpenVINO Runtime/GenAI 2026.3, llama.cpp b9940, nlohmann/json, Catch2, Node test runner, PowerShell

---

**Depends on:** A non-`NO-GO` result from `docs/superpowers/plans/2026-08-10-windows-npu-model-feasibility.md`.

### Task 1: Freeze protocol v1 as a shared contract

**Files:**
- Create: `native/local-inference-host/contracts/protocol-v1.schema.json`
- Create: `native/local-inference-host/contracts/protocol-examples.jsonl`
- Create: `native/local-inference-host/tests/protocol-contract.test.cjs`

- [ ] **Step 1: Write the failing contract test**

```javascript
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');

const root = path.resolve(__dirname, '..');
test('every protocol example validates against v1', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'contracts/protocol-v1.schema.json')));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const lines = fs.readFileSync(path.join(root, 'contracts/protocol-examples.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse);
  for (const message of lines) assert.equal(validate(message), true, JSON.stringify(validate.errors));
});
```

- [ ] **Step 2: Run it and verify missing contract files**

Run: `node --test native/local-inference-host/tests/protocol-contract.test.cjs`

Expected: FAIL with `ENOENT`.

- [ ] **Step 3: Add the exact message envelope and operations**

The schema requires `protocolVersion: 1`, `type`, `requestId`, and `sessionId`. Its `type` enum is `hello`, `capabilities`, `model.prepare`, `model.ready`, `asr.start`, `asr.audio`, `asr.flush`, `asr.stop`, `asr.result`, `translate.preview`, `translate.final`, `translate.result`, `request.cancel`, `health`, `error`, and `shutdown`.

Use conditional schema branches so `asr.audio` requires `channel`, `encoding: "pcm_s16le"`, `sampleRate: 24000`, `capturedAt`, and base64 `audio`; translation requests require `utteranceId`, `sourceRevision`, `sourceLanguage`, `targetLanguage`, and `text`; all result messages require `model`, `runtime`, `requestedDevice`, `actualDevice`, and `inferenceMs`.

Examples must include hello/capabilities, both channels, partial and final ASR, provisional and authoritative translation, cancellation, a structured error, health, and shutdown.

- [ ] **Step 4: Run the contract test**

Run: `node --test native/local-inference-host/tests/protocol-contract.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add native/local-inference-host/contracts native/local-inference-host/tests/protocol-contract.test.cjs
git commit -m "test: define local inference protocol v1"
```

### Task 2: Scaffold a deterministic C++ host with fake engines

**Files:**
- Create: `native/local-inference-host/CMakeLists.txt`
- Create: `native/local-inference-host/vcpkg.json`
- Create: `native/local-inference-host/src/engine.h`
- Create: `native/local-inference-host/src/fake_engine.h`
- Create: `native/local-inference-host/src/fake_engine.cpp`
- Create: `native/local-inference-host/src/protocol_server.h`
- Create: `native/local-inference-host/src/protocol_server.cpp`
- Create: `native/local-inference-host/src/main.cpp`
- Create: `native/local-inference-host/tests/protocol_server_test.cpp`

- [ ] **Step 1: Write the failing fake-engine protocol test**

```cpp
TEST_CASE("hello returns protocol and fake capabilities") {
  auto engines = twinscript::FakeEngines{};
  auto server = twinscript::ProtocolServer{engines};
  auto reply = server.handle({
    {"protocolVersion", 1}, {"type", "hello"},
    {"requestId", "r1"}, {"sessionId", "s1"}
  });
  REQUIRE(reply.at("type") == "capabilities");
  REQUIRE(reply.at("protocolVersion") == 1);
  REQUIRE(reply.at("models").size() == 2);
}
```

- [ ] **Step 2: Add the CMake targets and confirm the test fails to link**

`vcpkg.json` declares `nlohmann-json` and `catch2`. `CMakeLists.txt` creates `local_inference_core`, `twinscript-local-inference`, and `local_inference_tests`, enables CTest, and copies no model weights.

Run: `cmake -S native/local-inference-host -B native/local-inference-host/build -A x64 -DTWINSCRIPT_FAKE_ENGINES=ON`

Run: `cmake --build native/local-inference-host/build --config Debug`

Expected before implementation: compile or link failure for `ProtocolServer`.

- [ ] **Step 3: Implement focused engine interfaces**

```cpp
struct DeviceEvidence {
  std::string model;
  std::string runtime;
  std::string requested_device;
  std::string actual_device;
};

struct AsrRequest {
  std::string session_id, request_id, channel;
  std::vector<std::int16_t> samples;
  std::int64_t captured_at;
};

struct TranslationRequest {
  std::string session_id, request_id, utterance_id;
  std::uint64_t source_revision;
  std::string source_language, target_language, text;
  bool authoritative;
};

class IAsrEngine {
 public:
  virtual ~IAsrEngine() = default;
  virtual void start(std::string_view session, std::string_view channel) = 0;
  virtual std::vector<nlohmann::json> append(const AsrRequest&) = 0;
  virtual std::vector<nlohmann::json> flush(std::string_view session, std::string_view channel) = 0;
  virtual void stop(std::string_view session, std::string_view channel) = 0;
};

class ITranslationEngine {
 public:
  virtual ~ITranslationEngine() = default;
  virtual nlohmann::json translate(const TranslationRequest&, std::stop_token) = 0;
};
```

`FakeEngines` returns deterministic English/Chinese strings and device evidence `runtime=fake`, `actualDevice=CPU`. `ProtocolServer::handle` validates protocol version and required envelope fields before dispatch.

- [ ] **Step 4: Build and run CTest**

Run: `cmake --build native/local-inference-host/build --config Debug`

Run: `ctest --test-dir native/local-inference-host/build -C Debug --output-on-failure`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add native/local-inference-host/CMakeLists.txt native/local-inference-host/vcpkg.json native/local-inference-host/src native/local-inference-host/tests/protocol_server_test.cpp
git commit -m "feat: scaffold bounded local inference host"
```

### Task 3: Add bounded JSON-lines transport and cancellation

**Files:**
- Create: `native/local-inference-host/src/json_line_transport.h`
- Create: `native/local-inference-host/src/json_line_transport.cpp`
- Create: `native/local-inference-host/src/request_registry.h`
- Create: `native/local-inference-host/src/request_registry.cpp`
- Create: `native/local-inference-host/tests/json_line_transport_test.cpp`
- Create: `native/local-inference-host/tests/request_registry_test.cpp`

- [ ] **Step 1: Test size, parse, and cancellation limits**

```cpp
TEST_CASE("transport rejects a line above one MiB") {
  twinscript::JsonLineTransport transport{1024 * 1024};
  REQUIRE_THROWS_AS(transport.parse(std::string(1024 * 1024 + 1, 'x')), twinscript::ProtocolError);
}

TEST_CASE("request cancellation stops only the matching generation") {
  twinscript::RequestRegistry registry;
  auto first = registry.begin("request-1");
  auto second = registry.begin("request-2");
  REQUIRE(registry.cancel("request-1"));
  REQUIRE(first.stop_requested());
  REQUIRE_FALSE(second.stop_requested());
}
```

- [ ] **Step 2: Run CTest and verify the missing types fail**

Run: `cmake --build native/local-inference-host/build --config Debug`

Expected: FAIL compiling the new tests.

- [ ] **Step 3: Implement one-reader/one-writer transport**

The stdin reader rejects invalid UTF-8, malformed JSON, unsupported versions, and lines over 1 MiB with one structured `error`. The stdout writer owns all writes through a mutex and emits exactly one compact JSON object plus newline per message. Audio is decoded only after its base64 length is checked against 480,000 bytes. `RequestRegistry` uses `std::stop_source`, rejects duplicate active request IDs, and removes a request on completion.

- [ ] **Step 4: Test invalid input without terminating the host**

Run: `ctest --test-dir native/local-inference-host/build -C Debug --output-on-failure`

Expected: PASS, including malformed JSON followed by a valid health request.

- [ ] **Step 5: Commit**

```powershell
git add native/local-inference-host/src/json_line_transport.* native/local-inference-host/src/request_registry.* native/local-inference-host/tests/json_line_transport_test.cpp native/local-inference-host/tests/request_registry_test.cpp
git commit -m "feat: bound local inference transport and cancellation"
```

### Task 4: Implement the OpenVINO Whisper engine

**Files:**
- Create: `native/local-inference-host/src/openvino_whisper_engine.h`
- Create: `native/local-inference-host/src/openvino_whisper_engine.cpp`
- Create: `native/local-inference-host/src/audio_segmenter.h`
- Create: `native/local-inference-host/src/audio_segmenter.cpp`
- Create: `native/local-inference-host/tests/audio_segmenter_test.cpp`
- Create: `native/local-inference-host/tests/whisper_engine_smoke.cpp`

- [ ] **Step 1: Test channel isolation and 24 kHz to 16 kHz resampling**

```cpp
TEST_CASE("segmenter maintains independent channels") {
  twinscript::AudioSegmenter segmenter{24000, 16000};
  segmenter.append("microphone", std::vector<std::int16_t>(24000, 100));
  segmenter.append("system", std::vector<std::int16_t>(12000, -100));
  REQUIRE(segmenter.samples("microphone").size() == 16000);
  REQUIRE(segmenter.samples("system").size() == 8000);
}
```

- [ ] **Step 2: Implement bounded channel state**

Use a polyphase or linear resampler whose output count is deterministic, a 30-second maximum rolling buffer per channel, VAD-bounded utterances, and overlap retained only for the next decode. Flushing clears only the named channel.

- [ ] **Step 3: Implement `OpenVinoWhisperEngine`**

Construct one `ov::genai::WhisperPipeline` per active channel using the selected model directory and device from the feasibility result. Warm each pipeline during `model.prepare`. Map decoded partial/final text to protocol events with model `whisper-small`, runtime `openvino-genai`, requested and actual device, audio duration, and inference timing. Do not use `AUTO`; pass `NPU`, `GPU`, or `CPU` explicitly.

- [ ] **Step 4: Run unit tests and the opt-in model smoke test**

Run: `ctest --test-dir native/local-inference-host/build -C Debug --output-on-failure`

Expected: pure unit tests PASS. `whisper_engine_smoke` reports SKIP unless `TWINSCRIPT_WHISPER_MODEL` is set.

Run with the exported model: `ctest --test-dir native/local-inference-host/build -C Debug -R whisper_engine_smoke --output-on-failure`

Expected: PASS with an `actualDevice` matching the feasibility allocation.

- [ ] **Step 5: Commit**

```powershell
git add native/local-inference-host/src/openvino_whisper_engine.* native/local-inference-host/src/audio_segmenter.* native/local-inference-host/tests/audio_segmenter_test.cpp native/local-inference-host/tests/whisper_engine_smoke.cpp
git commit -m "feat: serve local Whisper transcription"
```

### Task 5: Implement the OpenVINO Hy-MT2 engine

**Files:**
- Create: `native/local-inference-host/src/hy_mt2_prompt.h`
- Create: `native/local-inference-host/src/hy_mt2_prompt.cpp`
- Create: `native/local-inference-host/src/openvino_hy_mt2_engine.h`
- Create: `native/local-inference-host/src/openvino_hy_mt2_engine.cpp`
- Create: `native/local-inference-host/tests/hy_mt2_prompt_test.cpp`
- Create: `native/local-inference-host/tests/hy_mt2_engine_smoke.cpp`

- [ ] **Step 1: Test the model-card prompt and output cleanup**

```cpp
TEST_CASE("Hy-MT2 uses a user-only directional prompt") {
  REQUIRE(twinscript::hy_mt2_prompt("Hold ±0.2 mm.", "Chinese") ==
    "Translate the following text into Chinese. Note that you should only output "
    "the translated result without any additional explanation: Hold ±0.2 mm.");
}
```

- [ ] **Step 2: Implement prompt and engine**

Construct one warm `ov::genai::LLMPipeline` using the feasibility-selected device. Translate with greedy deterministic generation, `max_new_tokens=256`, and a stop token from the converted tokenizer. Return input/output token counts when available. Strip only leading/trailing whitespace and known transcript tags; do not rewrite model content heuristically.

- [ ] **Step 3: Make cancellation and priority observable**

Preview requests carry priority 0 and final requests priority 10. A final request cancels the same utterance's preview before entering the engine queue. Cancellation returns no result event; an engine error returns a structured result-scoped error without killing ASR.

- [ ] **Step 4: Run CTest and opt-in bilingual smoke tests**

Run: `ctest --test-dir native/local-inference-host/build -C Debug --output-on-failure`

Expected: unit tests PASS; model smoke test skips without `TWINSCRIPT_HYMT2_MODEL`.

With the model path set, the smoke test translates EN→ZH and ZH→EN, preserves `±0.2 mm` and `24 VDC`, and reports the actual device selected in feasibility.

- [ ] **Step 5: Commit**

```powershell
git add native/local-inference-host/src/hy_mt2_prompt.* native/local-inference-host/src/openvino_hy_mt2_engine.* native/local-inference-host/tests/hy_mt2_prompt_test.cpp native/local-inference-host/tests/hy_mt2_engine_smoke.cpp
git commit -m "feat: serve local Hy-MT2 translation"
```

### Task 6: Enforce ASR-first scheduling and stable residency

**Files:**
- Create: `native/local-inference-host/src/inference_scheduler.h`
- Create: `native/local-inference-host/src/inference_scheduler.cpp`
- Create: `native/local-inference-host/tests/inference_scheduler_test.cpp`

- [ ] **Step 1: Write failing priority and bound tests**

```cpp
TEST_CASE("final translation overtakes queued previews but never audio") {
  twinscript::InferenceScheduler queue{24};
  queue.push({.kind = Kind::Preview, .id = "p1"});
  queue.push({.kind = Kind::Audio, .id = "a1"});
  queue.push({.kind = Kind::Final, .id = "f1"});
  REQUIRE(queue.pop().id == "a1");
  REQUIRE(queue.pop().id == "f1");
}
```

- [ ] **Step 2: Implement bounded priority with preview shedding**

Order is audio/ASR, final translation, then preview. When full, discard the oldest queued preview; never discard audio or a final request silently. Expose running, queued-by-kind, maximum depth, and model load counts through `health`.

- [ ] **Step 3: Run CTest and a 60-minute host soak**

Run: `ctest --test-dir native/local-inference-host/build -C Release --output-on-failure`

Expected: PASS.

Feed the feasibility corpus through the executable for 60 minutes. Expected: selected devices remain stable, each model load count stays at one, queue depth remains bounded, and the process emits valid health responses throughout.

- [ ] **Step 4: Commit**

```powershell
git add native/local-inference-host/src/inference_scheduler.* native/local-inference-host/tests/inference_scheduler_test.cpp
git commit -m "feat: prioritize continuous local transcription"
```

### Task 7: Produce a relocatable Release artifact

**Files:**
- Create: `scripts/build-local-inference-host.ps1`
- Create: `scripts/verify-local-inference-host.ps1`
- Create: `native/local-inference-host/README.md`
- Modify: `.gitignore`
- Modify: `.github/workflows/windows-ci.yml`

- [ ] **Step 1: Write the build script around explicit inputs**

The build script accepts `-OpenVinoRoot`, `-Configuration Release`, and `-OutputDirectory`. It configures CMake x64, builds the executable and CTest target, runs CTest, copies only the executable plus required OpenVINO runtime/plugin DLLs and licenses, and writes `runtime-manifest.json` with SHA-256 hashes. It never copies model weights.

- [ ] **Step 2: Add verification that fails closed**

`verify-local-inference-host.ps1` launches the staged executable, sends hello and health JSON lines, requires protocol version 1, checks every runtime hash, and fails if Python is found in the staged dependency list.

- [ ] **Step 3: Run the Release build and verifier**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-local-inference-host.ps1 -OpenVinoRoot $env:OPENVINO_ROOT -OutputDirectory artifacts/local-inference-host`

Expected: CTest passes and a relocatable host is staged.

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-local-inference-host.ps1 -HostDirectory artifacts/local-inference-host`

Expected: protocol and hash verification PASS.

- [ ] **Step 4: Add CI without downloading model weights**

Windows CI builds with `TWINSCRIPT_FAKE_ENGINES=ON`, runs CTest, and runs the staged hello/health verification. Hardware model smokes remain an explicit local/release-lab gate.

- [ ] **Step 5: Commit**

```powershell
git add .gitignore .github/workflows/windows-ci.yml scripts/build-local-inference-host.ps1 scripts/verify-local-inference-host.ps1 native/local-inference-host/README.md
git commit -m "build: stage local inference host runtime"
```

### Task 8: Final host verification checkpoint

- [ ] **Step 1: Run contract, C++, and staging tests**

Run: `node --test native/local-inference-host/tests/protocol-contract.test.cjs`

Run: `ctest --test-dir native/local-inference-host/build -C Release --output-on-failure`

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-local-inference-host.ps1 -HostDirectory artifacts/local-inference-host`

Expected: all commands PASS.

- [ ] **Step 2: Confirm the host is independently usable**

Start the staged host with `--model-root` and `--allocation` from the feasibility result, then send hello, prepare, one ASR utterance, one preview translation, one cancelled preview, one final translation, health, and shutdown. Expected: valid v1 responses, correct bilingual text, truthful devices, no network dependency during the run, and exit code 0.
