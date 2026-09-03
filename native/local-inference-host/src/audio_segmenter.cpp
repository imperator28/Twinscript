#include "audio_segmenter.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>


namespace twinscript {

UtteranceGate::UtteranceGate(
    int sample_rate,
    double speech_threshold,
    int trailing_silence_ms,
    int maximum_utterance_ms)
    : sample_rate_(sample_rate),
      speech_threshold_(speech_threshold),
      trailing_silence_samples_(
          static_cast<std::size_t>(sample_rate) * trailing_silence_ms / 1000),
      maximum_utterance_samples_(
          static_cast<std::size_t>(sample_rate) * maximum_utterance_ms / 1000) {
  if (sample_rate <= 0 || speech_threshold <= 0 || trailing_silence_ms <= 0 ||
      maximum_utterance_ms <= trailing_silence_ms) {
    throw std::invalid_argument("utterance gate configuration is invalid");
  }
}

UtteranceDecision UtteranceGate::observe(
    const std::vector<std::int16_t>& input) {
  if (input.empty()) return {};
  double square_sum = 0;
  for (const auto sample : input) {
    const auto normalized = static_cast<double>(sample) / 32768.0;
    square_sum += normalized * normalized;
  }
  const auto rms = std::sqrt(square_sum / static_cast<double>(input.size()));
  const bool speech = rms >= speech_threshold_;
  if (!speech && !speech_seen_) return {};

  const bool speech_started = speech && !speech_seen_;
  speech_seen_ = speech_seen_ || speech;
  buffered_samples_ += input.size();
  if (speech) silence_samples_ = 0;
  else silence_samples_ += input.size();
  return {
      true,
      speech_seen_ &&
          (silence_samples_ >= trailing_silence_samples_ ||
           buffered_samples_ >= maximum_utterance_samples_),
      speech_started,
  };
}

void UtteranceGate::reset() {
  buffered_samples_ = 0;
  silence_samples_ = 0;
  speech_seen_ = false;
}

UtteranceGate make_local_whisper_utterance_gate() {
  // Keep short pauses inside one phrase so Whisper has enough context for
  // multilingual identification. Refresh after twelve seconds of continuous
  // speech so a code-switch can still be reconsidered without a pause.
  return UtteranceGate{24000, 0.001, 500, 12000};
}

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
