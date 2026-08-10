#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>


namespace twinscript {

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
