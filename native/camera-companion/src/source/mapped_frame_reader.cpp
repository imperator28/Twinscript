#include "mapped_frame_reader.h"

#include <atomic>
#include <cstring>
#include <limits>

namespace twinscript::vcam {
namespace {

uint64_t AtomicLoad(const uint64_t* value) {
  return std::atomic_ref<uint64_t>(*const_cast<uint64_t*>(value))
      .load(std::memory_order_acquire);
}

bool ValidGeometry(const frame_transport::FrameHeader& header, size_t mappedBytes) {
  using namespace frame_transport;
  if (header.magic != kMagic || header.protocolVersion != kProtocolVersion ||
      header.pixelFormat != kPixelFormatBgra8 || header.width == 0 || header.height == 0 ||
      header.slotCount < 2 || header.stride != header.width * 4 ||
      header.payloadBytes != header.stride * header.height) {
    return false;
  }
  const uint64_t required = static_cast<uint64_t>(kHeaderBytes) +
                            static_cast<uint64_t>(header.payloadBytes) * header.slotCount;
  return required <= mappedBytes && required <= std::numeric_limits<size_t>::max();
}

}  // namespace

uint64_t MonotonicNowNs() {
  LARGE_INTEGER counter{};
  LARGE_INTEGER frequency{};
  if (!::QueryPerformanceCounter(&counter) || !::QueryPerformanceFrequency(&frequency) ||
      frequency.QuadPart <= 0) {
    return 0;
  }
  const uint64_t seconds = static_cast<uint64_t>(counter.QuadPart / frequency.QuadPart);
  const uint64_t remainder = static_cast<uint64_t>(counter.QuadPart % frequency.QuadPart);
  return seconds * 1'000'000'000ULL +
         remainder * 1'000'000'000ULL / static_cast<uint64_t>(frequency.QuadPart);
}

HRESULT MappedFrameReader::Open(const wchar_t* path) {
  Close();
  if (!path || !*path) return E_INVALIDARG;

  file_ = ::CreateFileW(path, GENERIC_READ,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file_ == INVALID_HANDLE_VALUE) return HRESULT_FROM_WIN32(::GetLastError());

  LARGE_INTEGER size{};
  if (!::GetFileSizeEx(file_, &size) || size.QuadPart < 0 ||
      static_cast<uint64_t>(size.QuadPart) > std::numeric_limits<size_t>::max()) {
    const HRESULT hr = HRESULT_FROM_WIN32(::GetLastError());
    Close();
    return FAILED(hr) ? hr : E_INVALIDARG;
  }
  mapped_bytes_ = static_cast<size_t>(size.QuadPart);
  if (mapped_bytes_ < frame_transport::kHeaderBytes) {
    Close();
    return E_INVALIDARG;
  }

  mapping_ = ::CreateFileMappingW(file_, nullptr, PAGE_READONLY, 0, 0, nullptr);
  if (!mapping_) {
    const HRESULT hr = HRESULT_FROM_WIN32(::GetLastError());
    Close();
    return hr;
  }
  view_ = static_cast<const uint8_t*>(
      ::MapViewOfFile(mapping_, FILE_MAP_READ, 0, 0, mapped_bytes_));
  if (!view_) {
    const HRESULT hr = HRESULT_FROM_WIN32(::GetLastError());
    Close();
    return hr;
  }
  header_ = reinterpret_cast<const frame_transport::FrameHeader*>(view_);
  if (!ValidGeometry(*header_, mapped_bytes_)) {
    Close();
    return E_INVALIDARG;
  }
  return S_OK;
}

void MappedFrameReader::Close() {
  header_ = nullptr;
  if (view_) ::UnmapViewOfFile(view_);
  view_ = nullptr;
  if (mapping_) ::CloseHandle(mapping_);
  mapping_ = nullptr;
  if (file_ != INVALID_HANDLE_VALUE) ::CloseHandle(file_);
  file_ = INVALID_HANDLE_VALUE;
  mapped_bytes_ = 0;
  last_sequence_ = 0;
}

FrameReadResult MappedFrameReader::Read(uint8_t* destination, size_t destinationBytes,
                                        uint64_t nowMonotonicNs) {
  using namespace frame_transport;
  if (!header_ || !destination || destinationBytes < header_->payloadBytes) {
    return {FrameReadStatus::kInvalid};
  }

  const auto writer_state = static_cast<WriterState>(header_->writerState);
  if (writer_state == WriterState::kStarting || writer_state == WriterState::kIdle) {
    return {FrameReadStatus::kIdle};
  }
  if (writer_state == WriterState::kStopped) return {FrameReadStatus::kStopped};
  if (writer_state != WriterState::kLive) return {FrameReadStatus::kInvalid};

  const uint64_t sequence_before = AtomicLoad(&header_->frameSequence);
  if (sequence_before == 0) return {FrameReadStatus::kNoFrame};
  const uint64_t captured = AtomicLoad(&header_->capturedAtMonotonicNs);
  if (nowMonotonicNs > captured &&
      nowMonotonicNs - captured > kLastFrameRepeatLimitNs) {
    return {FrameReadStatus::kExpired, sequence_before, captured};
  }

  const uint32_t slot = static_cast<uint32_t>(sequence_before % header_->slotCount);
  const size_t offset = SlotOffset(header_->payloadBytes, slot);
  std::memcpy(destination, view_ + offset, header_->payloadBytes);

  const uint64_t sequence_after = AtomicLoad(&header_->frameSequence);
  if (sequence_after != sequence_before) {
    return {FrameReadStatus::kTorn, sequence_after, captured};
  }

  const bool fresh = sequence_before != last_sequence_;
  last_sequence_ = sequence_before;
  return {fresh ? FrameReadStatus::kFresh : FrameReadStatus::kRepeat,
          sequence_before, captured};
}

}  // namespace twinscript::vcam

