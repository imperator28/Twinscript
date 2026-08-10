#pragma once

#include <filesystem>
#include <string>

#include "engine.h"
#include "openvino_whisper_engine.h"


namespace twinscript {

class NativeEngines : public IEngineFacade {
 public:
  NativeEngines(
      std::filesystem::path whisper_model,
      std::string whisper_device,
      std::filesystem::path cache_path = {});

  nlohmann::json capabilities() const override;
  nlohmann::json health() const override;
  nlohmann::json prepare(const std::vector<std::string>& models) override;
  nlohmann::json asr_start(std::string_view session, std::string_view channel) override;
  nlohmann::json transcribe(const AsrRequest& request) override;
  nlohmann::json asr_flush(std::string_view session, std::string_view channel) override;
  nlohmann::json asr_stop(std::string_view session, std::string_view channel) override;
  nlohmann::json translate(const TranslationRequest& request) override;

 private:
  OpenVinoWhisperEngine whisper_;
};

}  // namespace twinscript
