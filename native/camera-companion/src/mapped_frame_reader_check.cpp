#include <windows.h>

#include <cstdio>
#include <cstring>
#include <vector>

#include "frame_transport.h"
#include "frame_source.h"
#include "mapped_frame_reader.h"

using twinscript::frame_transport::FrameHeader;
using twinscript::frame_transport::SlotOffset;
using twinscript::frame_transport::WriterState;
using twinscript::vcam::FrameReadStatus;
using twinscript::vcam::MappedFrameReader;
using twinscript::vcam::MonotonicNowNs;

namespace {

int Fail(const char* message) {
  std::printf("FAIL  %s\n", message);
  return 1;
}

bool Expect(FrameReadStatus actual, FrameReadStatus expected, const char* label) {
  if (actual == expected) {
    std::printf("ok    %s\n", label);
    return true;
  }
  std::printf("FAIL  %s status=%u expected=%u\n", label, static_cast<unsigned>(actual),
              static_cast<unsigned>(expected));
  return false;
}

}  // namespace

int ReadExternalRegion(const wchar_t* path, int expected_byte) {
  MappedFrameReader reader;
  const HRESULT open = reader.Open(path);
  if (FAILED(open)) {
    std::printf("FAIL  external region open 0x%08lX\n", static_cast<unsigned long>(open));
    return 1;
  }
  const size_t payload = reader.PayloadBytes();
  if (payload != 1920u * 1080u * 4u) return Fail("external payload is not 1920x1080 BGRA");
  std::vector<uint8_t> output(payload);
  const auto result = reader.Read(output.data(), output.size(), MonotonicNowNs());
  if (result.status != FrameReadStatus::kFresh || output.front() != expected_byte ||
      output.back() != expected_byte) {
    return Fail("external full-size frame did not round-trip");
  }
  std::printf("ok    external full-size frame %zu bytes sequence=%llu\n", payload,
              static_cast<unsigned long long>(result.sequence));
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 5 && ::wcscmp(argv[1], L"--region") == 0 &&
      ::wcscmp(argv[3], L"--expect-byte") == 0) {
    const int expected = ::_wtoi(argv[4]);
    if (expected < 0 || expected > 255) return Fail("expected byte must be 0-255");
    return ReadExternalRegion(argv[2], expected);
  }
  constexpr uint32_t width = 4;
  constexpr uint32_t height = 2;
  constexpr uint32_t stride = width * 4;
  constexpr uint32_t payload = stride * height;
  constexpr uint32_t slots = 2;
  constexpr size_t total = twinscript::frame_transport::kHeaderBytes + payload * slots;

  wchar_t directory[MAX_PATH] = {};
  wchar_t path[MAX_PATH] = {};
  if (!::GetTempPathW(MAX_PATH, directory) ||
      !::GetTempFileNameW(directory, L"bmf", 0, path)) {
    return Fail("temporary region path");
  }

  HANDLE file = ::CreateFileW(path, GENERIC_READ | GENERIC_WRITE,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, nullptr);
  if (file == INVALID_HANDLE_VALUE) return Fail("create region");
  LARGE_INTEGER length{};
  length.QuadPart = total;
  if (!::SetFilePointerEx(file, length, nullptr, FILE_BEGIN) || !::SetEndOfFile(file)) {
    ::CloseHandle(file);
    return Fail("size region");
  }
  HANDLE mapping = ::CreateFileMappingW(file, nullptr, PAGE_READWRITE, 0, 0, nullptr);
  if (!mapping) {
    ::CloseHandle(file);
    return Fail("map region");
  }
  auto* bytes = static_cast<uint8_t*>(::MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, total));
  if (!bytes) {
    ::CloseHandle(mapping);
    ::CloseHandle(file);
    return Fail("view region");
  }

  std::memset(bytes, 0, total);
  auto* header = reinterpret_cast<FrameHeader*>(bytes);
  header->magic = twinscript::frame_transport::kMagic;
  header->protocolVersion = twinscript::frame_transport::kProtocolVersion;
  header->width = width;
  header->height = height;
  header->pixelFormat = twinscript::frame_transport::kPixelFormatBgra8;
  header->stride = stride;
  header->payloadBytes = payload;
  header->slotCount = slots;
  header->writerState = static_cast<uint32_t>(WriterState::kStarting);
  header->frameRate = 15;

  MappedFrameReader reader;
  if (FAILED(reader.Open(path))) return Fail("reader opens valid region");
  std::vector<uint8_t> output(payload);
  if (!Expect(reader.Read(output.data(), output.size(), MonotonicNowNs()).status,
              FrameReadStatus::kIdle, "starting is privacy idle")) return 1;

  const uint64_t now = MonotonicNowNs();
  std::memset(bytes + SlotOffset(payload, 1), 0x2a, payload);
  header->capturedAtMonotonicNs = now;
  header->writerState = static_cast<uint32_t>(WriterState::kLive);
  header->frameSequence = 1;
  auto result = reader.Read(output.data(), output.size(), now);
  if (!Expect(result.status, FrameReadStatus::kFresh, "fresh coherent frame") ||
      output.front() != 0x2a || output.back() != 0x2a) return 1;
  if (!Expect(reader.Read(output.data(), output.size(), now).status,
              FrameReadStatus::kRepeat, "unchanged sequence repeats")) return 1;

  header->capturedAtMonotonicNs =
      now - twinscript::frame_transport::kLastFrameRepeatLimitNs - 1;
  if (!Expect(reader.Read(output.data(), output.size(), now).status,
              FrameReadStatus::kExpired, "old frame expires")) return 1;

  header->writerState = static_cast<uint32_t>(WriterState::kIdle);
  if (!Expect(reader.Read(output.data(), output.size(), now).status,
              FrameReadStatus::kIdle, "idle requests privacy slate")) return 1;
  header->writerState = static_cast<uint32_t>(WriterState::kStopped);
  if (!Expect(reader.Read(output.data(), output.size(), now).status,
              FrameReadStatus::kStopped, "stopped requests disconnected slate")) return 1;

  header->writerState = static_cast<uint32_t>(WriterState::kLive);
  header->capturedAtMonotonicNs = MonotonicNowNs();
  header->frameSequence = 2;
  std::memset(bytes + SlotOffset(payload, 0), 0x4b, payload);
  twinscript::vcam::FrameSource frames;
  frames.Configure(width, height, 15, path, false);
  std::vector<uint8_t> stage(payload);
  frames.WriteFrame(stage.data(), twinscript::vcam::OutputFormat::kRgb32);
  if (stage.front() != 0x4b || stage.back() != 0x4b) {
    return Fail("FrameSource did not prefer the mapped stage");
  }
  std::printf("ok    FrameSource prefers mapped stage pixels\n");

  header->capturedAtMonotonicNs =
      MonotonicNowNs() - twinscript::frame_transport::kLastFrameRepeatLimitNs - 1;
  frames.WriteFrame(stage.data(), twinscript::vcam::OutputFormat::kRgb32);
  if (stage.front() == 0x4b && stage.back() == 0x4b) {
    return Fail("expired mapped stage remained frozen");
  }
  std::printf("ok    FrameSource replaces expired pixels with a slate\n");

  reader.Close();
  header->magic = 0;
  MappedFrameReader malformed;
  if (SUCCEEDED(malformed.Open(path))) return Fail("malformed header was accepted");
  std::printf("ok    malformed region rejected\n");

  ::UnmapViewOfFile(bytes);
  ::CloseHandle(mapping);
  ::CloseHandle(file);
  ::DeleteFileW(path);
  return 0;
}
