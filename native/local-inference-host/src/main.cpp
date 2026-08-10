#include <filesystem>
#include <iostream>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

#include "fake_engine.h"
#include "json_line_transport.h"
#include "protocol_server.h"
#ifdef TWINSCRIPT_OPENVINO_GENAI
#include "native_engines.h"
#endif


int main(int argc, char* argv[]) {
  std::unique_ptr<twinscript::IEngineFacade> engines;
#ifdef TWINSCRIPT_OPENVINO_GENAI
  std::filesystem::path whisper_model;
  std::filesystem::path cache_path;
  std::string whisper_device = "NPU";
  for (int index = 1; index < argc; ++index) {
    const std::string argument = argv[index];
    if (argument == "--whisper-model" && index + 1 < argc) whisper_model = argv[++index];
    else if (argument == "--whisper-device" && index + 1 < argc) whisper_device = argv[++index];
    else if (argument == "--cache-dir" && index + 1 < argc) cache_path = argv[++index];
  }
  if (!whisper_model.empty()) {
    engines = std::make_unique<twinscript::NativeEngines>(
        whisper_model, whisper_device, cache_path);
  }
#endif
  if (!engines) engines = std::make_unique<twinscript::FakeEngines>();
  auto server = twinscript::ProtocolServer{*engines};
  const auto transport = twinscript::JsonLineTransport{1024 * 1024};
  std::string line;
  while (std::getline(std::cin, line)) {
    nlohmann::json reply;
    nlohmann::json request;
    try {
      request = transport.parse(line);
      reply = server.handle(request);
    } catch (const std::exception& error) {
      reply = {
          {"protocolVersion", 1},
          {"type", "error"},
          {"requestId", request.is_object() ? request.value("requestId", "unknown") : "unknown"},
          {"sessionId", request.is_object() ? request.value("sessionId", "unknown") : "unknown"},
          {"code", request.empty() ? "invalid_json" : "local_inference_failed"},
          {"message", error.what()},
      };
    }
    std::cout << transport.serialize(reply) << std::flush;
    if (reply.value("type", "") == "shutdown") {
      break;
    }
  }
  return 0;
}
