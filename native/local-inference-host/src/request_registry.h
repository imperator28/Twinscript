#pragma once

#include <mutex>
#include <stop_token>
#include <string>
#include <string_view>
#include <unordered_map>

#include "json_line_transport.h"


namespace twinscript {

class RequestRegistry {
 public:
  std::stop_token begin(std::string request_id);
  bool cancel(std::string_view request_id);
  bool complete(std::string_view request_id);

 private:
  std::mutex mutex_;
  std::unordered_map<std::string, std::stop_source> requests_;
};

}  // namespace twinscript
