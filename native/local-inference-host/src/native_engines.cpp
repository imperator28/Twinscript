#include "native_engines.h"

#include <stdexcept>
#include <utility>


namespace twinscript {

NativeEngines::NativeEngines(
    std::filesystem::path whisper_model,
    std::string whisper_device,
    std::filesystem::path cache_path)
    : whisper_(
          std::move(whisper_model),
          std::move(whisper_device),
          std::move(cache_path)) {}

nlohmann::json NativeEngines::capabilities() const {
  return nlohmann::json::array({whisper_.capability()});
}

nlohmann::json NativeEngines::health() const {
  return {
      {"queueDepth", 0},
      {"models", {{"whisper-small", whisper_.health()}}},
  };
}

nlohmann::json NativeEngines::prepare(const std::vector<std::string>&) {
  return {{"models", capabilities()}};
}

nlohmann::json NativeEngines::asr_start(
    std::string_view session,
    std::string_view channel) {
  return whisper_.start(session, channel);
}

nlohmann::json NativeEngines::transcribe(const AsrRequest& request) {
  return whisper_.append(request);
}

nlohmann::json NativeEngines::asr_flush(
    std::string_view session,
    std::string_view channel) {
  return whisper_.flush(session, channel);
}

nlohmann::json NativeEngines::asr_stop(
    std::string_view session,
    std::string_view channel) {
  return whisper_.stop(session, channel);
}

nlohmann::json NativeEngines::translate(const TranslationRequest&) {
  throw std::runtime_error("Hy-MT2 requests must use the supervised llama.cpp runtime");
}

}  // namespace twinscript
