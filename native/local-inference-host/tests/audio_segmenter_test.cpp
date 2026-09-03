#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "audio_segmenter.h"


TEST_CASE("segmenter resamples and isolates audio channels") {
  twinscript::AudioSegmenter segmenter{24000, 16000, 30};
  segmenter.append("microphone", std::vector<std::int16_t>(24000, 100));
  segmenter.append("system", std::vector<std::int16_t>(12000, -100));

  REQUIRE(segmenter.samples("microphone").size() == 16000);
  REQUIRE(segmenter.samples("system").size() == 8000);
  REQUIRE(segmenter.samples("microphone").front() > 0.0f);
  REQUIRE(segmenter.samples("system").front() < 0.0f);
}

TEST_CASE("segmenter bounds each channel and flushes only the requested channel") {
  twinscript::AudioSegmenter segmenter{24000, 16000, 1};
  segmenter.append("microphone", std::vector<std::int16_t>(48000, 50));
  segmenter.append("system", std::vector<std::int16_t>(24000, 60));

  REQUIRE(segmenter.samples("microphone").size() == 16000);
  REQUIRE(segmenter.take("microphone").size() == 16000);
  REQUIRE(segmenter.samples("microphone").empty());
  REQUIRE(segmenter.samples("system").size() == 16000);
}

TEST_CASE("utterance gate finalizes speech after bounded trailing silence") {
  twinscript::UtteranceGate gate{24000, 0.01, 500, 20000};
  const auto leading = gate.observe(std::vector<std::int16_t>(6000, 0));
  REQUIRE_FALSE(leading.append);
  REQUIRE_FALSE(leading.finalize);

  const auto speech = gate.observe(std::vector<std::int16_t>(24000, 1200));
  REQUIRE(speech.append);
  REQUIRE(speech.speech_started);
  REQUIRE_FALSE(speech.finalize);
  REQUIRE(gate.observe(std::vector<std::int16_t>(6000, 0)).finalize == false);
  REQUIRE(gate.observe(std::vector<std::int16_t>(6000, 0)).finalize == true);
}

TEST_CASE("utterance gate accepts quiet speech and identifies its onset") {
  twinscript::UtteranceGate gate{24000, 0.001, 500, 20000};
  REQUIRE_FALSE(gate.observe(std::vector<std::int16_t>(6000, 0)).append);

  const auto quiet_speech = gate.observe(std::vector<std::int16_t>(2400, 100));
  REQUIRE(quiet_speech.append);
  REQUIRE(quiet_speech.speech_started);
  REQUIRE_FALSE(quiet_speech.finalize);
}

TEST_CASE("utterance gate force-finalizes continuous speech before the audio cap") {
  twinscript::UtteranceGate gate{24000, 0.01, 500, 20000};
  twinscript::UtteranceDecision decision;
  for (int second = 0; second < 20; ++second) {
    decision = gate.observe(std::vector<std::int16_t>(24000, 1200));
  }
  REQUIRE(decision.append);
  REQUIRE(decision.finalize);

  gate.reset();
  REQUIRE_FALSE(gate.observe(std::vector<std::int16_t>(24000, 0)).append);
}

TEST_CASE("local Whisper gate retains context through short pauses") {
  auto gate = twinscript::make_local_whisper_utterance_gate();

  REQUIRE_FALSE(
      gate.observe(std::vector<std::int16_t>(24000, 1200)).finalize);
  REQUIRE_FALSE(
      gate.observe(std::vector<std::int16_t>(6000, 0)).finalize);
  REQUIRE_FALSE(
      gate.observe(std::vector<std::int16_t>(5999, 0)).finalize);
  REQUIRE(
      gate.observe(std::vector<std::int16_t>(1, 0)).finalize);
}

TEST_CASE("local Whisper gate periodically refreshes language with useful context") {
  auto gate = twinscript::make_local_whisper_utterance_gate();
  twinscript::UtteranceDecision decision;

  for (int second = 0; second < 11; ++second) {
    decision = gate.observe(std::vector<std::int16_t>(24000, 1200));
    REQUIRE_FALSE(decision.finalize);
  }

  decision = gate.observe(std::vector<std::int16_t>(24000, 1200));
  REQUIRE(decision.append);
  REQUIRE(decision.finalize);
}
