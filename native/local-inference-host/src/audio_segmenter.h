#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>


namespace twinscript {

struct UtteranceDecision {
  bool append{};
  bool finalize{};
  bool speech_started{};
};

class UtteranceGate {
 public:
  UtteranceGate(
      int sample_rate,
      double speech_threshold,
      int trailing_silence_ms,
      int maximum_utterance_ms);

  UtteranceDecision observe(const std::vector<std::int16_t>& input);
  void reset();

 private:
  int sample_rate_;
  double speech_threshold_;
  std::size_t trailing_silence_samples_;
  std::size_t maximum_utterance_samples_;
  std::size_t buffered_samples_{};
  std::size_t silence_samples_{};
  bool speech_seen_{};
};

class AudioSegmenter {
 public:
  AudioSegmenter(int input_rate, int output_rate, int maximum_seconds);

  void append(std::string_view channel, const std::vector<std::int16_t>& input);
  std::vector<float> samples(std::string_view channel) const;
  std::vector<float> take(std::string_view channel);

 private:
  std::vector<float> resample(const std::vector<std::int16_t>& input) const;

  int input_rate_;
  int output_rate_;
  std::size_t maximum_input_samples_;
  std::unordered_map<std::string, std::vector<std::int16_t>> channels_;
};

}  // namespace twinscript
