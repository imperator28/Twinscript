#pragma once

#include <nlohmann/json.hpp>

#include "engine.h"


namespace twinscript {

class ProtocolServer {
 public:
  explicit ProtocolServer(IEngineFacade& engines) : engines_(engines) {}

  nlohmann::json handle(const nlohmann::json& request);

 private:
  nlohmann::json envelope(const nlohmann::json& request, std::string type) const;
  nlohmann::json error(
      const nlohmann::json& request,
      std::string code,
      std::string message) const;

  IEngineFacade& engines_;
};

}  // namespace twinscript
