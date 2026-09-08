#include "openvino_whisper_engine.h"

#include <cctype>
#include <chrono>
#include <cstddef>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
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

// This product transcribes exactly two languages. Whisper detects all
// ninety-nine.
//
// The generation config left `language` unset, so detection ran free - and
// because a live session re-detects at every phrase boundary (see
// audio_segmenter.h), one short phrase is all it takes to land somewhere else
// entirely. English speech came back as Swedish: "Kan du hora mig?" for "can you
// hear me". Downstream that reads as a successful transcript, so the translator
// faithfully translated the Swedish and the operator saw fluent nonsense in the
// original column with no indication anything had gone wrong.
//
// Detect, then constrain: keep the free detection, and when it lands outside
// English or Chinese, decode the same audio once more with the language pinned.
// Constraining up front instead would be worse - pinning English would wreck
// Chinese speech and vice versa, and this app exists to caption both.
constexpr std::string_view kEnglish = "en";
constexpr std::string_view kChinese = "zh";

/// Whisper reports languages as either "en" or "<|en|>" depending on the export.
std::string normalize_language(std::string_view raw) {
  std::string code;
  for (const char character : raw) {
    if (character == '<' || character == '>' || character == '|') continue;
    code.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(character))));
  }
  // Regional variants ("zh-cn") collapse to the base language.
  const auto dash = code.find_first_of("-_");
  if (dash != std::string::npos) code.resize(dash);
  return code;
}

bool is_supported_language(std::string_view code) {
  return code == kEnglish || code == kChinese;
}

std::string first_language(const ov::genai::ASRDecodedResults& decoded) {
  if (decoded.languages.empty()) return {};
  return normalize_language(decoded.languages.front());
}

std::string first_text(const ov::genai::ASRDecodedResults& decoded) {
  return decoded.texts.empty() ? std::string{} : decoded.texts.front();
}

}  // namespace

class OpenVinoWhisperEngine::Impl {
 public:
  struct ChannelState {
    std::string session;
    std::size_t sequence{};
    std::size_t revision{};
    std::size_t last_decoded_samples{};
    UtteranceGate gate{make_local_whisper_utterance_gate()};
    std::vector<std::int16_t> pre_roll;
    // The language this channel was last heard speaking, and therefore the one
    // to fall back to when detection wanders off. Empty until the first
    // supported result, so the very first phrase falls back to English rather
    // than to whatever was misdetected.
    std::string last_supported_language;
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
    // Live utterances are capped at twelve seconds. The exported model's default
    // of 448 tokens lets a rare repetition loop monopolize the NPU long enough
    // to overflow the real-time audio queue. Sixty-four tokens is ample for a
    // twelve-second English or Chinese phrase and bounds worst-case decode time.
    config.max_new_tokens = 64;
    auto decoded = pipeline->generate(ov::genai::AudioInputs{audio}, config);

    // Detect, then constrain. See kEnglish/kChinese above for why this is not
    // simply pinned from the start.
    std::string language = first_language(decoded);
    bool constrained = false;
    if (!is_supported_language(language)) {
      const std::string fallback = state.last_supported_language.empty()
          ? std::string{kEnglish}
          : state.last_supported_language;
      auto pinned = config;
      pinned.language = "<|" + fallback + "|>";
      // Exactly one retry. A second miss keeps the pinned result rather than
      // looping: the audio queue is real-time and an unbounded retry would
      // starve it.
      decoded = pipeline->generate(ov::genai::AudioInputs{audio}, pinned);
      language = fallback;
      constrained = true;
    }
    if (is_supported_language(language)) state.last_supported_language = language;

    ++state.revision;
    return {
        {"language", language},
        {"languageConstrained", constrained},
        {"channel", channel},
        {"utteranceId", state.session + ":" + channel + ":" + std::to_string(state.sequence)},
        {"revision", state.revision},
        {"text", first_text(decoded)},
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
  state.pre_roll.clear();
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
    state.pre_roll.insert(
        state.pre_roll.end(), request.samples.begin(), request.samples.end());
    constexpr std::size_t maximum_pre_roll_samples = 12000;
    if (state.pre_roll.size() > maximum_pre_roll_samples) {
      state.pre_roll.erase(
          state.pre_roll.begin(),
          state.pre_roll.end() - maximum_pre_roll_samples);
    }
    return { {"channel", request.channel}, {"accepted", true} };
  }
  if (decision.speech_started && !state.pre_roll.empty()) {
    impl_->segmenter.append(request.channel, state.pre_roll);
    state.pre_roll.clear();
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
    state.pre_roll.clear();
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
  if (audio.empty()) {
    state.gate.reset();
    state.pre_roll.clear();
    return {{"channel", channel}, {"state", "flushed"}};
  }
  auto response = impl_->result(std::string(channel), true, audio);
  ++state.sequence;
  state.revision = 0;
  state.last_decoded_samples = 0;
  state.gate.reset();
  state.pre_roll.clear();
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
