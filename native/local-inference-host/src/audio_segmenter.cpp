#include "audio_segmenter.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>


namespace twinscript {

AudioSegmenter::AudioSegmenter(
    int input_rate,
    int output_rate,
    int maximum_seconds)
    : input_rate_(input_rate),
      output_rate_(output_rate),
      maximum_input_samples_(static_cast<std::size_t>(input_rate) * maximum_seconds) {
  if (input_rate <= 0 || output_rate <= 0 || maximum_seconds <= 0) {
    throw std::invalid_argument("audio segmenter rates and duration must be positive");
  }
}

void AudioSegmenter::append(
    std::string_view channel,
    const std::vector<std::int16_t>& input) {
  auto& stored = channels_[std::string(channel)];
  stored.insert(stored.end(), input.begin(), input.end());
  if (stored.size() > maximum_input_samples_) {
    stored.erase(stored.begin(), stored.end() - maximum_input_samples_);
  }
}

std::vector<float> AudioSegmenter::resample(
    const std::vector<std::int16_t>& input) const {
  const auto output_size = input.size() * static_cast<std::size_t>(output_rate_) /
                           static_cast<std::size_t>(input_rate_);
  std::vector<float> output;
  output.reserve(output_size);
  for (std::size_t index = 0; index < output_size; ++index) {
    const double source = static_cast<double>(index) * input_rate_ / output_rate_;
    const auto lower = static_cast<std::size_t>(source);
    const auto upper = std::min(lower + 1, input.size() - 1);
    const float fraction = static_cast<float>(source - lower);
    const float interpolated = input[lower] * (1.0f - fraction) + input[upper] * fraction;
    output.push_back(interpolated / 32768.0f);
  }
  return output;
}

std::vector<float> AudioSegmenter::samples(std::string_view channel) const {
  const auto found = channels_.find(std::string(channel));
  if (found == channels_.end() || found->second.empty()) return {};
  return resample(found->second);
}

std::vector<float> AudioSegmenter::take(std::string_view channel) {
  auto found = channels_.find(std::string(channel));
  if (found == channels_.end() || found->second.empty()) return {};
  auto result = resample(found->second);
  found->second.clear();
  return result;
}

}  // namespace twinscript
