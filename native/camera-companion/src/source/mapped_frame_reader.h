#pragma once

#include <windows.h>

#include <cstddef>
#include <cstdint>

#include "frame_transport.h"

namespace twinscript::vcam {

enum class FrameReadStatus : uint32_t {
  kFresh = 0,
  kRepeat = 1,
  kNoFrame = 2,
  kExpired = 3,
  kIdle = 4,
  kStopped = 5,
  kTorn = 6,
  kInvalid = 7,
};

struct FrameReadResult {
  FrameReadStatus status = FrameReadStatus::kInvalid;
  uint64_t sequence = 0;
  uint64_t capturedAtMonotonicNs = 0;
};

uint64_t MonotonicNowNs();

class MappedFrameReader {
 public:
  MappedFrameReader() = default;
  ~MappedFrameReader() { Close(); }

  MappedFrameReader(const MappedFrameReader&) = delete;
  MappedFrameReader& operator=(const MappedFrameReader&) = delete;

  HRESULT Open(const wchar_t* path);
  void Close();
  FrameReadResult Read(uint8_t* destination, size_t destinationBytes,
                       uint64_t nowMonotonicNs = MonotonicNowNs());

  bool IsOpen() const { return view_ != nullptr; }
  size_t PayloadBytes() const { return header_ ? header_->payloadBytes : 0; }
  const frame_transport::FrameHeader* Header() const { return header_; }

 private:
  HANDLE file_ = INVALID_HANDLE_VALUE;
  HANDLE mapping_ = nullptr;
  const uint8_t* view_ = nullptr;
  const frame_transport::FrameHeader* header_ = nullptr;
  size_t mapped_bytes_ = 0;
  uint64_t last_sequence_ = 0;
};

}  // namespace twinscript::vcam
