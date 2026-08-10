#include "json_line_transport.h"


namespace twinscript {

nlohmann::json JsonLineTransport::parse(std::string_view line) const {
  if (line.size() > maximum_line_bytes_) {
    throw ProtocolError("JSON line exceeds the configured byte limit");
  }
  try {
    return nlohmann::json::parse(line.begin(), line.end());
  } catch (const nlohmann::json::exception& error) {
    throw ProtocolError(std::string("invalid JSON: ") + error.what());
  }
}

std::string JsonLineTransport::serialize(const nlohmann::json& message) const {
  auto line = message.dump();
  if (line.size() > maximum_line_bytes_) {
    throw ProtocolError("serialized JSON exceeds the configured byte limit");
  }
  line.push_back('\n');
  return line;
}

}  // namespace twinscript
