#include <catch2/catch_test_macros.hpp>

#include "request_registry.h"


TEST_CASE("request cancellation stops only the matching generation") {
  twinscript::RequestRegistry registry;
  auto first = registry.begin("request-1");
  auto second = registry.begin("request-2");

  REQUIRE(registry.cancel("request-1"));
  REQUIRE(first.stop_requested());
  REQUIRE_FALSE(second.stop_requested());
}

TEST_CASE("duplicate active request ids are rejected and completion releases them") {
  twinscript::RequestRegistry registry;
  registry.begin("request-1");

  REQUIRE_THROWS_AS(registry.begin("request-1"), twinscript::ProtocolError);
  REQUIRE(registry.complete("request-1"));
  REQUIRE_NOTHROW(registry.begin("request-1"));
}
