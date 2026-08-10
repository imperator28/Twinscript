#include "request_registry.h"


namespace twinscript {

std::stop_token RequestRegistry::begin(std::string request_id) {
  std::lock_guard lock{mutex_};
  if (requests_.contains(request_id)) {
    throw ProtocolError("duplicate active requestId");
  }
  auto [entry, inserted] = requests_.emplace(std::move(request_id), std::stop_source{});
  return entry->second.get_token();
}

bool RequestRegistry::cancel(std::string_view request_id) {
  std::lock_guard lock{mutex_};
  const auto entry = requests_.find(std::string{request_id});
  return entry != requests_.end() && entry->second.request_stop();
}

bool RequestRegistry::complete(std::string_view request_id) {
  std::lock_guard lock{mutex_};
  return requests_.erase(std::string{request_id}) == 1;
}

}  // namespace twinscript
