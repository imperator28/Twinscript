#pragma once

#include <filesystem>
#include <memory>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

#include "engine.h"


namespace twinscript {

class OpenVinoWhisperEngine {
 public:
  OpenVinoWhisperEngine(
      std::filesystem::path model_path,
      std::string requested_device,
      std::filesystem::path cache_path = {});
  ~OpenVinoWhisperEngine();

  OpenVinoWhisperEngine(OpenVinoWhisperEngine&&) noexcept;
  OpenVinoWhisperEngine& operator=(OpenVinoWhisperEngine&&) noexcept;
  OpenVinoWhisperEngine(const OpenVinoWhisperEngine&) = delete;
  OpenVinoWhisperEngine& operator=(const OpenVinoWhisperEngine&) = delete;

  nlohmann::json capability() const;
  nlohmann::json health() const;
  nlohmann::json start(std::string_view session, std::string_view channel);
  nlohmann::json append(const AsrRequest& request);
  nlohmann::json flush(std::string_view session, std::string_view channel);
  nlohmann::json stop(std::string_view session, std::string_view channel);

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace twinscript
