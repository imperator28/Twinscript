#include "protocol_server.h"

#include <cstdint>
#include <array>
#include <stdexcept>
#include <string>
#include <vector>


namespace twinscript {
namespace {

bool has_string(const nlohmann::json& value, const char* key) {
  return value.contains(key) && value.at(key).is_string() &&
         !value.at(key).get_ref<const std::string&>().empty();
}

std::vector<std::uint8_t> decode_base64(const std::string& encoded) {
  static const auto table = [] {
    std::array<int, 256> values{};
    values.fill(-1);
    const std::string alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (std::size_t index = 0; index < alphabet.size(); ++index) {
      values[static_cast<unsigned char>(alphabet[index])] = static_cast<int>(index);
    }
    return values;
  }();
  if (encoded.empty() || encoded.size() % 4 != 0) {
    throw std::invalid_argument("audio is not valid base64");
  }
  std::vector<std::uint8_t> decoded;
  decoded.reserve(encoded.size() / 4 * 3);
  for (std::size_t offset = 0; offset < encoded.size(); offset += 4) {
    int values[4]{};
    for (int index = 0; index < 4; ++index) {
      const char character = encoded[offset + index];
      if (character == '=') {
        values[index] = 0;
      } else {
        values[index] = table[static_cast<unsigned char>(character)];
        if (values[index] < 0) throw std::invalid_argument("audio is not valid base64");
      }
    }
    const bool pad_two = encoded[offset + 2] == '=';
    const bool pad_three = encoded[offset + 3] == '=';
    if ((pad_two && !pad_three) ||
        ((pad_two || pad_three) && offset + 4 != encoded.size())) {
      throw std::invalid_argument("audio is not valid base64");
    }
    decoded.push_back(static_cast<std::uint8_t>((values[0] << 2) | (values[1] >> 4)));
    if (!pad_two) {
      decoded.push_back(static_cast<std::uint8_t>((values[1] << 4) | (values[2] >> 2)));
    }
    if (!pad_three) {
      decoded.push_back(static_cast<std::uint8_t>((values[2] << 6) | values[3]));
    }
  }
  return decoded;
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
    std::vector<std::string> models;
    if (request.contains("models") && request.at("models").is_array()) {
      for (const auto& model : request.at("models")) {
        if (model.is_string()) models.push_back(model);
      }
    }
    reply.update(engines_.prepare(models));
    return reply;
  }
  if (type == "asr.start" || type == "asr.flush" || type == "asr.stop") {
    if (!has_string(request, "channel")) {
      return error(request, "invalid_audio_contract", "channel is required");
    }
    nlohmann::json payload;
    std::string response_type = "health";
    if (type == "asr.start") {
      payload = engines_.asr_start(request.at("sessionId"), request.at("channel"));
    } else if (type == "asr.flush") {
      payload = engines_.asr_flush(request.at("sessionId"), request.at("channel"));
      response_type = payload.contains("text") ? "asr.result" : "health";
    } else {
      payload = engines_.asr_stop(request.at("sessionId"), request.at("channel"));
    }
    auto reply = envelope(request, response_type);
    reply.update(payload);
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
    std::vector<std::uint8_t> decoded;
    try {
      decoded = decode_base64(request.at("audio"));
    } catch (const std::exception& exception) {
      return error(request, "invalid_audio_contract", exception.what());
    }
    if (decoded.size() > 480000 || decoded.size() % sizeof(std::int16_t) != 0) {
      return error(request, "invalid_audio_contract", "decoded audio must contain bounded pcm_s16le samples");
    }
    std::vector<std::int16_t> samples(decoded.size() / sizeof(std::int16_t));
    for (std::size_t index = 0; index < samples.size(); ++index) {
      samples[index] = static_cast<std::int16_t>(
          static_cast<std::uint16_t>(decoded[index * 2]) |
          (static_cast<std::uint16_t>(decoded[index * 2 + 1]) << 8));
    }
    const AsrRequest audio{
        .session_id = request.at("sessionId"),
        .request_id = request.at("requestId"),
        .channel = request.at("channel"),
        .samples = std::move(samples),
        .captured_at = request.at("capturedAt"),
    };
    auto reply = envelope(request, "asr.result");
    const auto payload = engines_.transcribe(audio);
    if (!payload.contains("text")) reply["type"] = "health";
    reply.update(payload);
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
