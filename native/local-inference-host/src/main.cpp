#include <iostream>
#include <string>

#include <nlohmann/json.hpp>

#include "fake_engine.h"
#include "protocol_server.h"


int main() {
  auto engines = twinscript::FakeEngines{};
  auto server = twinscript::ProtocolServer{engines};
  std::string line;
  while (std::getline(std::cin, line)) {
    nlohmann::json reply;
    try {
      const auto request = nlohmann::json::parse(line);
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
    std::cout << reply.dump() << '\n' << std::flush;
    if (reply.value("type", "") == "shutdown") {
      break;
    }
  }
  return 0;
}
