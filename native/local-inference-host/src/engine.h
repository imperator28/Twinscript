#pragma once

#include <cstdint>
#include <stop_token>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>


namespace twinscript {

struct DeviceEvidence {
  std::string model;
  std::string runtime;
  std::string requested_device;
  std::string actual_device;
};

struct AsrRequest {
  std::string session_id;
  std::string request_id;
  std::string channel;
  std::vector<std::int16_t> samples;
  std::int64_t captured_at{};
};

struct TranslationRequest {
  std::string session_id;
  std::string request_id;
  std::string utterance_id;
  std::uint64_t source_revision{};
  std::string source_language;
  std::string target_language;
  std::string text;
  bool authoritative{};
};

class IAsrEngine {
 public:
  virtual ~IAsrEngine() = default;
  virtual void start(std::string_view session, std::string_view channel) = 0;
  virtual std::vector<nlohmann::json> append(const AsrRequest&) = 0;
  virtual std::vector<nlohmann::json> flush(
      std::string_view session,
      std::string_view channel) = 0;
  virtual void stop(std::string_view session, std::string_view channel) = 0;
};

class ITranslationEngine {
 public:
  virtual ~ITranslationEngine() = default;
  virtual nlohmann::json translate(
      const TranslationRequest&,
      std::stop_token) = 0;
};

class IEngineFacade {
 public:
  virtual ~IEngineFacade() = default;
  virtual nlohmann::json capabilities() const = 0;
  virtual nlohmann::json health() const = 0;
  virtual nlohmann::json prepare(const std::vector<std::string>& models) = 0;
  virtual nlohmann::json asr_start(
      std::string_view session,
      std::string_view channel) = 0;
  virtual nlohmann::json transcribe(const AsrRequest& request) = 0;
  virtual nlohmann::json asr_flush(
      std::string_view session,
      std::string_view channel) = 0;
  virtual nlohmann::json asr_stop(
      std::string_view session,
      std::string_view channel) = 0;
  virtual nlohmann::json translate(const TranslationRequest& request) = 0;
};

}  // namespace twinscript
