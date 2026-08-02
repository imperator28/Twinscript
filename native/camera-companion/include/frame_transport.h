// Shared-memory frame contract — C++ side.
//
// This is the mirror of electron/captions/camera-frame-transport.js. The two
// files describe the same bytes and MUST agree; a drift guard
// (electron/captions/camera-frame-transport.test.cjs) parses this header and
// fails if any constant or offset diverges. Change both together, and bump
// kProtocolVersion for any layout change so an older peer rejects the region
// instead of misinterpreting it.

#pragma once

#include <cstddef>
#include <cstdint>

namespace bilingual::frame_transport {

// 'BMCF' little-endian: Bilingual Meeting Captions Frames.
constexpr uint32_t kMagic = 0x464d4342;
constexpr uint32_t kProtocolVersion = 1;

constexpr uint32_t kPixelFormatBgra8 = 1;

enum class WriterState : uint32_t {
  kStarting = 0,
  kLive = 1,
  kIdle = 2,
  kStopped = 3,
};

constexpr uint32_t kOffsetMagic = 0;
constexpr uint32_t kOffsetProtocolVersion = 4;
constexpr uint32_t kOffsetWidth = 8;
constexpr uint32_t kOffsetHeight = 12;
constexpr uint32_t kOffsetPixelFormat = 16;
constexpr uint32_t kOffsetStride = 20;
constexpr uint32_t kOffsetPayloadBytes = 24;
constexpr uint32_t kOffsetSlotCount = 28;
constexpr uint32_t kOffsetWriterState = 32;
constexpr uint32_t kOffsetFrameRate = 36;
constexpr uint32_t kOffsetCapturedAtMonotonicNs = 40;
constexpr uint32_t kOffsetFrameSequence = 48;
constexpr uint32_t kHeaderBytes = 64;

constexpr uint32_t kDefaultWidth = 1920;
constexpr uint32_t kDefaultHeight = 1080;
constexpr uint32_t kDefaultFrameRate = 15;
constexpr uint32_t kDefaultSlotCount = 2;

// Repeat the newest valid frame across a missed writer deadline for at most this
// long, then switch to the neutral disconnected slate rather than leave a frozen
// transcript looking live.
constexpr uint64_t kLastFrameRepeatLimitNs = 2000000000ULL;

// The header as laid out in shared memory. `frameSequence` is the publication
// point: the writer stores it last, and a reader that sees the same value before
// and after copying a slot knows the copy was not lapped.
#pragma pack(push, 1)
struct FrameHeader {
  uint32_t magic;
  uint32_t protocolVersion;
  uint32_t width;
  uint32_t height;
  uint32_t pixelFormat;
  uint32_t stride;
  uint32_t payloadBytes;
  uint32_t slotCount;
  uint32_t writerState;
  uint32_t frameRate;
  uint64_t capturedAtMonotonicNs;
  uint64_t frameSequence;
  uint8_t reserved[8];
};
#pragma pack(pop)

static_assert(sizeof(FrameHeader) == kHeaderBytes,
              "FrameHeader must match kHeaderBytes exactly");
static_assert(offsetof(FrameHeader, capturedAtMonotonicNs) == kOffsetCapturedAtMonotonicNs,
              "capturedAtMonotonicNs offset drifted from the JS contract");
static_assert(offsetof(FrameHeader, frameSequence) == kOffsetFrameSequence,
              "frameSequence offset drifted from the JS contract");
static_assert(kOffsetFrameSequence % 8 == 0,
              "frameSequence must stay 8-byte aligned so its store is atomic on x64");
static_assert(kOffsetCapturedAtMonotonicNs % 8 == 0,
              "capturedAtMonotonicNs must stay 8-byte aligned");

constexpr uint32_t SlotOffset(uint32_t payloadBytes, uint32_t slot) {
  return kHeaderBytes + payloadBytes * slot;
}

}  // namespace bilingual::frame_transport
