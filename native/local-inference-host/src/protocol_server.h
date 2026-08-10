#pragma once

#include <nlohmann/json.hpp>

#include "fake_engine.h"


namespace twinscript {

class ProtocolServer {
 public:
  explicit ProtocolServer(FakeEngines& engines) : engines_(engines) {}

  nlohmann::json handle(const nlohmann::json& request);

 private:
  nlohmann::json envelope(const nlohmann::json& request, std::string type) const;
  nlohmann::json error(
      const nlohmann::json& request,
      std::string code,
      std::string message) const;

  FakeEngines& engines_;
};

}  // namespace twinscript
