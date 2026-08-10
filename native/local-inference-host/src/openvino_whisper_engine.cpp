#include "openvino_whisper_engine.h"

#include <chrono>
#include <cstddef>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>

#include <openvino/genai/automatic_speech_recognition/pipeline.hpp>
#include <openvino/openvino.hpp>

#include "audio_segmenter.h"


namespace twinscript {
namespace {

using Clock = std::chrono::steady_clock;

double elapsed_ms(Clock::time_point started) {
  return std::chrono::duration<double, std::milli>(Clock::now() - started).count();
}

}  // namespace

class OpenVinoWhisperEngine::Impl {
 public:
  struct ChannelState {
    std::string session;
    std::size_t sequence{};
    std::size_t revision{};
    std::size_t last_decoded_samples{};
    UtteranceGate gate{24000, 0.01, 500, 20000};
  };

  Impl(
      const std::filesystem::path& model_path,
      std::string requested_device,
      const std::filesystem::path& cache_path)
      : requested_device(std::move(requested_device)),
        actual_device(this->requested_device),
        segmenter(24000, 16000, 30) {
    ov::AnyMap properties;
    if (!cache_path.empty() && this->requested_device != "CPU") {
      properties.insert(ov::cache_dir(cache_path.string()));
    }
    const auto started = Clock::now();
    pipeline = std::make_unique<ov::genai::ASRPipeline>(
        model_path,
        this->requested_device,
        properties);
    load_ms = elapsed_ms(started);
    ++load_count;
  }

  nlohmann::json result(
      const std::string& channel,
      bool final,
      const std::vector<float>& audio,
      std::int64_t captured_at = 0) {
    auto& state = channels[channel];
    const auto started = Clock::now();
    auto config = pipeline->get_generation_config();
    config.task = "transcribe";
    const auto decoded = pipeline->generate(ov::genai::AudioInputs{audio}, config);
    ++state.revision;
    return {
        {"channel", channel},
        {"utteranceId", state.session + ":" + channel + ":" + std::to_string(state.sequence)},
        {"revision", state.revision},
        {"text", decoded.texts.empty() ? std::string{} : decoded.texts.front()},
        {"final", final},
        {"capturedAt", captured_at},
        {"audioDurationMs", static_cast<double>(audio.size()) / 16.0},
        {"model", "whisper-small"},
        {"runtime", "openvino-genai-2026.3"},
        {"requestedDevice", requested_device},
        {"actualDevice", actual_device},
        {"inferenceMs", elapsed_ms(started)},
    };
  }

  std::string requested_device;
  std::string actual_device;
  std::unique_ptr<ov::genai::ASRPipeline> pipeline;
  AudioSegmenter segmenter;
  std::unordered_map<std::string, ChannelState> channels;
  std::mutex mutex;
  std::size_t load_count{};
  double load_ms{};
};

OpenVinoWhisperEngine::OpenVinoWhisperEngine(
    std::filesystem::path model_path,
    std::string requested_device,
    std::filesystem::path cache_path)
    : impl_(std::make_unique<Impl>(model_path, std::move(requested_device), cache_path)) {}

OpenVinoWhisperEngine::~OpenVinoWhisperEngine() = default;
OpenVinoWhisperEngine::OpenVinoWhisperEngine(OpenVinoWhisperEngine&&) noexcept = default;
OpenVinoWhisperEngine& OpenVinoWhisperEngine::operator=(OpenVinoWhisperEngine&&) noexcept = default;

nlohmann::json OpenVinoWhisperEngine::capability() const {
  return {
      {"id", "whisper-small"},
      {"runtime", "openvino-genai-2026.3"},
      {"requestedDevice", impl_->requested_device},
      {"actualDevice", impl_->actual_device},
  };
}

nlohmann::json OpenVinoWhisperEngine::health() const {
  return {
      {"loadCount", impl_->load_count},
      {"loadMs", impl_->load_ms},
      {"actualDevice", impl_->actual_device},
  };
}

nlohmann::json OpenVinoWhisperEngine::start(
    std::string_view session,
    std::string_view channel) {
  std::lock_guard lock(impl_->mutex);
  impl_->segmenter.take(channel);
  auto& state = impl_->channels[std::string(channel)];
  state.session = session;
  ++state.sequence;
  state.revision = 0;
  state.last_decoded_samples = 0;
  state.gate.reset();
  return {{"channel", channel}, {"state", "started"}};
}

nlohmann::json OpenVinoWhisperEngine::append(const AsrRequest& request) {
  std::lock_guard lock(impl_->mutex);
  auto& state = impl_->channels[request.channel];
  if (state.session.empty()) {
    state.session = request.session_id;
    ++state.sequence;
  }
  const auto decision = state.gate.observe(request.samples);
  if (!decision.append) {
    return { {"channel", request.channel}, {"accepted", true} };
  }
  impl_->segmenter.append(request.channel, request.samples);
  const auto audio = impl_->segmenter.samples(request.channel);
  if (decision.finalize) {
    auto response = impl_->result(request.channel, true, audio, request.captured_at);
    impl_->segmenter.take(request.channel);
    ++state.sequence;
    state.revision = 0;
    state.last_decoded_samples = 0;
    state.gate.reset();
    return response;
  }
  constexpr std::size_t decode_interval = 32000;
  if (audio.size() < decode_interval ||
      audio.size() - state.last_decoded_samples < decode_interval) {
    return {{"channel", request.channel}, {"accepted", true}};
  }
  state.last_decoded_samples = audio.size();
  return impl_->result(request.channel, false, audio, request.captured_at);
}

nlohmann::json OpenVinoWhisperEngine::flush(
    std::string_view session,
    std::string_view channel) {
  std::lock_guard lock(impl_->mutex);
  auto audio = impl_->segmenter.take(channel);
  auto& state = impl_->channels[std::string(channel)];
  if (state.session.empty()) state.session = session;
  if (audio.empty()) return {{"channel", channel}, {"state", "flushed"}};
  auto response = impl_->result(std::string(channel), true, audio);
  ++state.sequence;
  state.revision = 0;
  state.last_decoded_samples = 0;
  state.gate.reset();
  return response;
}

nlohmann::json OpenVinoWhisperEngine::stop(
    std::string_view,
    std::string_view channel) {
  std::lock_guard lock(impl_->mutex);
  impl_->segmenter.take(channel);
  impl_->channels.erase(std::string(channel));
  return {{"channel", channel}, {"state", "stopped"}};
}

}  // namespace twinscript
