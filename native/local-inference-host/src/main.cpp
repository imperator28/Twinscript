#include <iostream>
#include <string>

#include <nlohmann/json.hpp>

#include "fake_engine.h"
#include "json_line_transport.h"
#include "protocol_server.h"


int main() {
  auto engines = twinscript::FakeEngines{};
  auto server = twinscript::ProtocolServer{engines};
  const auto transport = twinscript::JsonLineTransport{1024 * 1024};
  std::string line;
  while (std::getline(std::cin, line)) {
    nlohmann::json reply;
    try {
      const auto request = transport.parse(line);
      reply = server.handle(request);
    } catch (const std::exception& error) {
      reply = {
          {"protocolVersion", 1},
          {"type", "error"},
          {"requestId", "unknown"},
          {"sessionId", "unknown"},
          {"code", "invalid_json"},
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
