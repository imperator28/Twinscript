#pragma once

#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>


namespace twinscript {

class ProtocolError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class JsonLineTransport {
 public:
  explicit JsonLineTransport(std::size_t maximum_line_bytes)
      : maximum_line_bytes_(maximum_line_bytes) {}

  nlohmann::json parse(std::string_view line) const;
  std::string serialize(const nlohmann::json& message) const;

 private:
  std::size_t maximum_line_bytes_;
};

}  // namespace twinscript
