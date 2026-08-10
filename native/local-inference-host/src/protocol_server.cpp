#include "protocol_server.h"

#include <cstdint>
#include <string>
#include <vector>


namespace twinscript {
namespace {

bool has_string(const nlohmann::json& value, const char* key) {
  return value.contains(key) && value.at(key).is_string() &&
         !value.at(key).get_ref<const std::string&>().empty();
}

}  // namespace

nlohmann::json ProtocolServer::envelope(
    const nlohmann::json& request,
    std::string type) const {
  return {
      {"protocolVersion", 1},
      {"type", std::move(type)},
      {"requestId", request.value("requestId", "unknown")},
      {"sessionId", request.value("sessionId", "unknown")},
  };
}

nlohmann::json ProtocolServer::error(
    const nlohmann::json& request,
    std::string code,
    std::string message) const {
  auto reply = envelope(request, "error");
  reply["code"] = std::move(code);
  reply["message"] = std::move(message);
  return reply;
}

nlohmann::json ProtocolServer::handle(const nlohmann::json& request) {
  if (!request.is_object() || !has_string(request, "requestId") ||
      !has_string(request, "sessionId") || !has_string(request, "type")) {
    return error(request, "invalid_envelope", "request envelope is incomplete");
  }
  if (!request.contains("protocolVersion") || request.at("protocolVersion") != 1) {
    return error(request, "unsupported_protocol", "protocolVersion must be 1");
  }

  const auto type = request.at("type").get<std::string>();
  if (type == "hello") {
    auto reply = envelope(request, "capabilities");
    reply["generation"] = 1;
    reply["models"] = engines_.capabilities();
    return reply;
  }
  if (type == "health") {
    auto reply = envelope(request, "health");
    reply["generation"] = 1;
    reply.update(engines_.health());
    return reply;
  }
  if (type == "model.prepare") {
    auto reply = envelope(request, "model.ready");
    reply["generation"] = 1;
    reply["models"] = engines_.capabilities();
    return reply;
  }
  if (type == "translate.preview" || type == "translate.final") {
    for (const auto* key : {"utteranceId", "sourceLanguage", "targetLanguage", "text"}) {
      if (!has_string(request, key)) {
        return error(request, "invalid_translation", std::string(key) + " is required");
      }
    }
    if (!request.contains("sourceRevision") ||
        !request.at("sourceRevision").is_number_integer() ||
        request.at("sourceRevision").get<std::int64_t>() < 0) {
      return error(request, "invalid_translation", "sourceRevision is required");
    }
    const TranslationRequest translation{
        .session_id = request.at("sessionId"),
        .request_id = request.at("requestId"),
        .utterance_id = request.at("utteranceId"),
        .source_revision = request.at("sourceRevision"),
        .source_language = request.at("sourceLanguage"),
        .target_language = request.at("targetLanguage"),
        .text = request.at("text"),
        .authoritative = type == "translate.final",
    };
    auto reply = envelope(request, "translate.result");
    reply.update(engines_.translate(translation));
    return reply;
  }
  if (type == "asr.audio") {
    if (request.value("encoding", "") != "pcm_s16le" ||
        request.value("sampleRate", 0) != 24000) {
      return error(request, "invalid_audio_contract", "audio must be 24 kHz pcm_s16le");
    }
    if (!has_string(request, "channel") || !has_string(request, "audio") ||
        !request.contains("capturedAt")) {
      return error(request, "invalid_audio_contract", "audio request is incomplete");
    }
    if (request.at("audio").get_ref<const std::string&>().size() > 640000) {
      return error(request, "audio_too_large", "decoded audio may not exceed 480000 bytes");
    }
    const AsrRequest audio{
        .session_id = request.at("sessionId"),
        .request_id = request.at("requestId"),
        .channel = request.at("channel"),
        .samples = {},
        .captured_at = request.at("capturedAt"),
    };
    auto reply = envelope(request, "asr.result");
    reply.update(engines_.transcribe(audio));
    return reply;
  }
  if (type == "request.cancel") {
    auto reply = envelope(request, "health");
    reply["cancelled"] = true;
    reply.update(engines_.health());
    return reply;
  }
  if (type == "shutdown") {
    return envelope(request, "shutdown");
  }
  return error(request, "unsupported_operation", "operation is not implemented");
}

}  // namespace twinscript
