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
