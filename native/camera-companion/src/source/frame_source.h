// Pixel production for the virtual camera.
//
// Stage 1 renders a synthetic pattern so the plumbing can be proven before the
// shared-memory bridge to Electron exists. The pattern is deliberately *moving*
// and carries the frame index: a frozen or repeated feed is then visible at a
// glance, which the W4 acceptance criteria require ("without a frozen or black
// frame"). A static colour fill would hide exactly the failure we care about.

#pragma once

#include <windows.h>
#include <mfidl.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "camera_runtime_paths.h"
#include "frame_transport.h"
#include "mapped_frame_reader.h"

namespace bilingual::vcam {

// Pixel layouts this source can hand to a consumer.
//
// NV12 is listed first in the stream descriptor because the Windows camera
// pipeline expects it from a capture source; advertising only RGB32 gets the
// device invalidated before streaming starts. RGB32 is retained as a second
// option because it is byte-identical to the BGRA8 shared-memory frame contract
// and needs no conversion, so a consumer that accepts it costs nothing.
enum class OutputFormat { kNv12, kRgb32 };

class FrameSource {
 public:
  FrameSource() = default;

  void Configure(uint32_t width, uint32_t height, uint32_t frame_rate,
                 const wchar_t* region_path = nullptr, bool synthetic = false) {
    width_ = width;
    height_ = height;
    frame_rate_ = frame_rate ? frame_rate : 1;
    pixels_.assign(static_cast<size_t>(width_) * height_, 0u);
    mapped_pixels_.assign(PayloadBytes(), 0u);
    synthetic_ = synthetic || SyntheticFramesRequested();
    region_path_ = region_path && *region_path ? region_path : CameraFrameRegionPath();
    reader_.Close();
    if (!synthetic_) reader_.Open(region_path_.c_str());
    next_open_attempt_ns_ = 0;
    Reset();
  }

  uint32_t Width() const { return width_; }
  uint32_t Height() const { return height_; }
  uint32_t FrameRate() const { return frame_rate_; }
  uint32_t Stride() const { return width_ * 4; }
  size_t PayloadBytes() const { return static_cast<size_t>(Stride()) * height_; }

  size_t PayloadBytesFor(OutputFormat format) const {
    // NV12: a full-resolution Y plane plus a half-resolution interleaved UV
    // plane, so 1.5 bytes per pixel.
    return format == OutputFormat::kRgb32
               ? PayloadBytes()
               : static_cast<size_t>(width_) * height_ * 3 / 2;
  }

  // Render the next frame straight into `dest` in the requested layout.
  void WriteFrame(uint8_t* dest, OutputFormat format) {
    const uint8_t* bgra = nullptr;
    if (synthetic_) {
      bgra = Render();
    } else {
      const uint64_t now = MonotonicNowNs();
      if (!reader_.IsOpen() && now >= next_open_attempt_ns_) {
        reader_.Open(region_path_.c_str());
        next_open_attempt_ns_ = now + 1'000'000'000ULL;
      }
      const FrameReadResult result =
          reader_.Read(mapped_pixels_.data(), mapped_pixels_.size(), now);
      if (result.status == FrameReadStatus::kFresh ||
          result.status == FrameReadStatus::kRepeat) {
        bgra = mapped_pixels_.data();
      } else {
        const bool disconnected =
            result.status == FrameReadStatus::kExpired ||
            result.status == FrameReadStatus::kStopped ||
            result.status == FrameReadStatus::kInvalid ||
            result.status == FrameReadStatus::kTorn;
        bgra = RenderSlate(disconnected);
      }
    }
    if (format == OutputFormat::kRgb32) {
      ::memcpy(dest, bgra, PayloadBytes());
    } else {
      ConvertToNv12(bgra, dest);
    }
  }

  // 100-nanosecond units, matching IMFSample time.
  int64_t FrameDuration() const { return 10'000'000LL / frame_rate_; }

  // A pull-based consumer can request samples as quickly as its CPU permits.
  // Keep the source on its negotiated clock instead of manufacturing a burst of
  // samples whose timestamps merely *claim* to be real-time. Sleeping here also
  // prevents an idle camera preview from consuming a full core. If the process
  // was suspended, resynchronise rather than trying to catch up every missed
  // frame in a burst.
  void WaitForFrameDeadline() {
    const int64_t duration = FrameDuration();
    int64_t now = ::MFGetSystemTime();
    if (now > next_time_ + duration * 2) next_time_ = now;
    while (now < next_time_) {
      const int64_t remaining_100ns = next_time_ - now;
      const DWORD delay_ms = static_cast<DWORD>((remaining_100ns + 9'999) / 10'000);
      ::Sleep(delay_ms > 0 ? delay_ms : 1);
      now = ::MFGetSystemTime();
    }
  }

  void Reset() {
    frame_index_ = 0;
    next_time_ = ::MFGetSystemTime();
  }

  uint64_t FrameIndex() const { return frame_index_; }

  int64_t TakeTimestamp() {
    const int64_t time = next_time_;
    next_time_ += FrameDuration();
    return time;
  }

  // Render one BGRA frame, top-down, tight-packed.
  const uint8_t* Render() {
    const uint32_t index = static_cast<uint32_t>(frame_index_);
    // A vertical bar sweeping left to right once per second.
    const uint32_t bar_width = width_ / 24 + 1;
    const uint32_t travel = width_ + bar_width;
    const uint32_t bar_x = static_cast<uint32_t>(
        (static_cast<uint64_t>(index % frame_rate_) * travel) / frame_rate_);

    for (uint32_t y = 0; y < height_; ++y) {
      // Horizontal bands so a vertical flip or stride error is obvious.
      const uint8_t band = static_cast<uint8_t>((y * 255u) / (height_ ? height_ : 1));
      for (uint32_t x = 0; x < width_; ++x) {
        uint8_t b = 24;
        uint8_t g = static_cast<uint8_t>(band / 3);
        uint8_t r = 32;
        if (x >= bar_x && x < bar_x + bar_width) {
          // Bright bar; its colour also cycles so successive frames differ even
          // if the bar position happens to repeat.
          b = 255;
          g = static_cast<uint8_t>(64 + (index * 7) % 190);
          r = 255;
        }
        pixels_[static_cast<size_t>(y) * width_ + x] =
            (static_cast<uint32_t>(0xff) << 24) | (static_cast<uint32_t>(r) << 16) |
            (static_cast<uint32_t>(g) << 8) | b;
      }
    }

    // A 16x16 block per bit of the low 16 bits of the frame index, so a captured
    // still frame can be decoded back to its ordinal.
    for (uint32_t bit = 0; bit < 16 && (bit + 1) * 18 < width_; ++bit) {
      const bool on = (index >> bit) & 1u;
      const uint32_t colour = on ? 0xffffffffu : 0xff000000u;
      for (uint32_t y = 8; y < 24 && y < height_; ++y) {
        for (uint32_t x = 8 + bit * 18; x < 8 + bit * 18 + 16 && x < width_; ++x) {
          pixels_[static_cast<size_t>(y) * width_ + x] = colour;
        }
      }
    }

    ++frame_index_;
    return reinterpret_cast<const uint8_t*>(pixels_.data());
  }

 private:
  const uint8_t* RenderSlate(bool disconnected) {
    const uint8_t base_b = disconnected ? 42 : 31;
    const uint8_t base_g = disconnected ? 35 : 43;
    const uint8_t base_r = disconnected ? 58 : 52;
    for (uint32_t y = 0; y < height_; ++y) {
      const int64_t diagonal_x = static_cast<int64_t>(y) * width_ /
                                 (height_ ? height_ : 1);
      for (uint32_t x = 0; x < width_; ++x) {
        const bool border = x < 6 || y < 6 || x + 6 >= width_ || y + 6 >= height_;
        const int64_t signed_x = x;
        const bool diagonal = disconnected && signed_x > diagonal_x - 3 &&
                              signed_x < diagonal_x + 3;
        const uint8_t lift = border || diagonal ? 36 : 0;
        const uint8_t b = static_cast<uint8_t>(base_b + lift);
        const uint8_t g = static_cast<uint8_t>(base_g + lift);
        const uint8_t r = static_cast<uint8_t>(base_r + lift);
        pixels_[static_cast<size_t>(y) * width_ + x] =
            0xff000000u | (static_cast<uint32_t>(r) << 16) |
            (static_cast<uint32_t>(g) << 8) | b;
      }
    }
    ++frame_index_;
    return reinterpret_cast<const uint8_t*>(pixels_.data());
  }

  // BT.601 studio-swing BGRA -> NV12, the conversion the camera pipeline
  // assumes. Chroma is averaged over each 2x2 block rather than point-sampled so
  // caption edges do not shimmer between frames.
  void ConvertToNv12(const uint8_t* bgra, uint8_t* dest) const {
    uint8_t* y_plane = dest;
    uint8_t* uv_plane = dest + static_cast<size_t>(width_) * height_;

    for (uint32_t y = 0; y < height_; ++y) {
      const uint8_t* row = bgra + static_cast<size_t>(y) * width_ * 4;
      uint8_t* y_row = y_plane + static_cast<size_t>(y) * width_;
      for (uint32_t x = 0; x < width_; ++x) {
        const int b = row[x * 4 + 0];
        const int g = row[x * 4 + 1];
        const int r = row[x * 4 + 2];
        y_row[x] = static_cast<uint8_t>(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
      }
    }

    for (uint32_t y = 0; y + 1 < height_ || (height_ == 1 && y == 0); y += 2) {
      uint8_t* uv_row = uv_plane + static_cast<size_t>(y / 2) * width_;
      for (uint32_t x = 0; x < width_; x += 2) {
        int sum_b = 0, sum_g = 0, sum_r = 0, count = 0;
        for (uint32_t dy = 0; dy < 2 && y + dy < height_; ++dy) {
          const uint8_t* row = bgra + static_cast<size_t>(y + dy) * width_ * 4;
          for (uint32_t dx = 0; dx < 2 && x + dx < width_; ++dx) {
            sum_b += row[(x + dx) * 4 + 0];
            sum_g += row[(x + dx) * 4 + 1];
            sum_r += row[(x + dx) * 4 + 2];
            ++count;
          }
        }
        if (!count) continue;
        const int b = sum_b / count;
        const int g = sum_g / count;
        const int r = sum_r / count;
        uv_row[x] = static_cast<uint8_t>(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
        uv_row[x + 1] = static_cast<uint8_t>(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
      }
    }
  }

  uint32_t width_ = frame_transport::kDefaultWidth;
  uint32_t height_ = frame_transport::kDefaultHeight;
  uint32_t frame_rate_ = frame_transport::kDefaultFrameRate;
  uint64_t frame_index_ = 0;
  int64_t next_time_ = 1;
  bool synthetic_ = false;
  uint64_t next_open_attempt_ns_ = 0;
  std::wstring region_path_;
  MappedFrameReader reader_;
  std::vector<uint8_t> mapped_pixels_;
  std::vector<uint32_t> pixels_;
};

}  // namespace bilingual::vcam
