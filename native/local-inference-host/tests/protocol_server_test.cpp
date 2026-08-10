#include <catch2/catch_test_macros.hpp>

#include "fake_engine.h"
#include "protocol_server.h"


TEST_CASE("hello returns protocol and fake capabilities") {
  auto engines = twinscript::FakeEngines{};
  auto server = twinscript::ProtocolServer{engines};
  auto reply = server.handle({
      {"protocolVersion", 1},
      {"type", "hello"},
      {"requestId", "r1"},
      {"sessionId", "s1"},
  });

  REQUIRE(reply.at("type") == "capabilities");
  REQUIRE(reply.at("protocolVersion") == 1);
  REQUIRE(reply.at("models").size() == 2);
  REQUIRE(reply.at("models")[0].at("actualDevice") == "NPU");
  REQUIRE(reply.at("models")[1].at("actualDevice") == "CPU");
}

TEST_CASE("invalid envelopes return a structured error") {
  auto engines = twinscript::FakeEngines{};
  auto server = twinscript::ProtocolServer{engines};
  auto reply = server.handle({
      {"protocolVersion", 2},
      {"type", "health"},
      {"requestId", "r2"},
      {"sessionId", "s1"},
  });

  REQUIRE(reply.at("type") == "error");
  REQUIRE(reply.at("code") == "unsupported_protocol");
}

TEST_CASE("fake final translation preserves authority and device evidence") {
  auto engines = twinscript::FakeEngines{};
  auto server = twinscript::ProtocolServer{engines};
  auto reply = server.handle({
      {"protocolVersion", 1},
      {"type", "translate.final"},
      {"requestId", "r3"},
      {"sessionId", "s1"},
      {"utteranceId", "u1"},
      {"sourceRevision", 2},
      {"sourceLanguage", "English"},
      {"targetLanguage", "Chinese"},
      {"text", "Confirmed"},
  });

  REQUIRE(reply.at("type") == "translate.result");
  REQUIRE(reply.at("authoritative") == true);
  REQUIRE(reply.at("model") == "hy-mt2-1.8b");
  REQUIRE(reply.at("runtime") == "fake");
  REQUIRE(reply.at("actualDevice") == "CPU");
}

TEST_CASE("audio outside the 24 kHz contract is rejected") {
  auto engines = twinscript::FakeEngines{};
  auto server = twinscript::ProtocolServer{engines};
  auto reply = server.handle({
      {"protocolVersion", 1},
      {"type", "asr.audio"},
      {"requestId", "r4"},
      {"sessionId", "s1"},
      {"channel", "microphone"},
      {"encoding", "pcm_s16le"},
      {"sampleRate", 16000},
      {"capturedAt", 1},
      {"audio", "AAAA"},
  });

  REQUIRE(reply.at("type") == "error");
  REQUIRE(reply.at("code") == "invalid_audio_contract");
}
