#pragma once

#include "engine.h"


namespace twinscript {

class FakeEngines {
 public:
  nlohmann::json capabilities() const;
  nlohmann::json health() const;
  nlohmann::json translate(const TranslationRequest& request) const;
  nlohmann::json transcribe(const AsrRequest& request) const;
};

}  // namespace twinscript
