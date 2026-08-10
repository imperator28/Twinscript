#include <catch2/catch_test_macros.hpp>

#include "json_line_transport.h"


TEST_CASE("transport rejects a line above one MiB") {
  twinscript::JsonLineTransport transport{1024 * 1024};

  REQUIRE_THROWS_AS(
      transport.parse(std::string(1024 * 1024 + 1, 'x')),
      twinscript::ProtocolError);
}

TEST_CASE("transport reports malformed json without becoming unusable") {
  twinscript::JsonLineTransport transport{1024 * 1024};

  REQUIRE_THROWS_AS(transport.parse("{"), twinscript::ProtocolError);
  REQUIRE(transport.parse(R"({"type":"health"})").at("type") == "health");
}

TEST_CASE("transport emits exactly one compact line") {
  twinscript::JsonLineTransport transport{1024 * 1024};

  REQUIRE(transport.serialize({{"type", "health"}}) == "{\"type\":\"health\"}\n");
}
