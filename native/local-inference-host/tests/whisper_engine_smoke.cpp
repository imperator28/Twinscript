#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include "openvino_whisper_engine.h"


int main() {
  const char* model = std::getenv("TWINSCRIPT_WHISPER_MODEL");
  const char* device = std::getenv("TWINSCRIPT_WHISPER_DEVICE");
  const char* pcm_path = std::getenv("TWINSCRIPT_WHISPER_PCM24");
  if (!model) {
    std::cout << "SKIP: TWINSCRIPT_WHISPER_MODEL is not set\n";
    return 0;
  }
  twinscript::OpenVinoWhisperEngine engine{
      std::filesystem::path(model), device ? device : "NPU"};
  const auto capability = engine.capability();
  if (capability.at("actualDevice") != (device ? device : "NPU")) return 2;
  engine.start("smoke", "microphone");
  std::vector<std::int16_t> samples(48000, 0);
  if (pcm_path) {
    std::ifstream input(pcm_path, std::ios::binary | std::ios::ate);
    if (!input) return 4;
    const auto bytes = input.tellg();
    if (bytes <= 0 || bytes % static_cast<std::streamoff>(sizeof(std::int16_t)) != 0) return 5;
    samples.resize(static_cast<std::size_t>(bytes) / sizeof(std::int16_t));
    input.seekg(0);
    input.read(reinterpret_cast<char*>(samples.data()), bytes);
  }
  twinscript::AsrRequest request{
      .session_id = "smoke",
      .request_id = "audio",
      .channel = "microphone",
      .samples = std::move(samples),
      .captured_at = 1,
  };
  const auto result = engine.append(request);
  std::cout << result.dump() << '\n';
  return result.value("runtime", "") == "openvino-genai-2026.3" ? 0 : 3;
}
