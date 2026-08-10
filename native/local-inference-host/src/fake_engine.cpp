#include "fake_engine.h"


namespace twinscript {

nlohmann::json FakeEngines::capabilities() const {
  return nlohmann::json::array({
      {
          {"id", "whisper-small"},
          {"runtime", "openvino-genai"},
          {"requestedDevice", "NPU"},
          {"actualDevice", "NPU"},
      },
      {
          {"id", "hy-mt2-1.8b"},
          {"runtime", "llama.cpp"},
          {"requestedDevice", "CPU"},
          {"actualDevice", "CPU"},
      },
  });
}

nlohmann::json FakeEngines::health() const {
  return {
      {"queueDepth", 0},
      {"models", {
          {"whisper-small", {{"loadCount", 1}, {"actualDevice", "NPU"}}},
          {"hy-mt2-1.8b", {{"loadCount", 1}, {"actualDevice", "CPU"}}},
      }},
  };
}

nlohmann::json FakeEngines::translate(const TranslationRequest& request) const {
  return {
      {"utteranceId", request.utterance_id},
      {"sourceRevision", request.source_revision},
      {"text", request.target_language == "Chinese" ? "已确认" : "Confirmed"},
      {"authoritative", request.authoritative},
      {"model", "hy-mt2-1.8b"},
      {"runtime", "fake"},
      {"requestedDevice", "CPU"},
      {"actualDevice", "CPU"},
      {"inferenceMs", 0.0},
  };
}

nlohmann::json FakeEngines::transcribe(const AsrRequest& request) const {
  return {
      {"channel", request.channel},
      {"utteranceId", request.request_id},
      {"text", request.channel == "microphone" ? "Hello" : "System audio"},
      {"final", false},
      {"model", "whisper-small"},
      {"runtime", "fake"},
      {"requestedDevice", "NPU"},
      {"actualDevice", "CPU"},
      {"inferenceMs", 0.0},
  };
}

}  // namespace twinscript
