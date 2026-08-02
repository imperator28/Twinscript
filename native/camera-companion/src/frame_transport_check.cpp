// Compiling this file is the native half of the frame-contract guard: the
// static_asserts in frame_transport.h only run when something includes it.
// The JS half lives in electron/captions/camera-frame-transport.test.cjs.

#include "frame_transport.h"

namespace {

using namespace bilingual::frame_transport;

// The geometry the companion is built for, checked at compile time so a bad
// default cannot ship.
constexpr uint32_t kDefaultStride = kDefaultWidth * 4;
constexpr uint32_t kDefaultPayloadBytes = kDefaultStride * kDefaultHeight;

static_assert(kDefaultPayloadBytes == 1920u * 1080u * 4u,
              "default payload must be one 1920x1080 BGRA8 frame");
static_assert(SlotOffset(kDefaultPayloadBytes, 0) == kHeaderBytes,
              "slot 0 must start immediately after the header");
static_assert(SlotOffset(kDefaultPayloadBytes, 1) == kHeaderBytes + kDefaultPayloadBytes,
              "slot 1 must not overlap slot 0");
static_assert(kDefaultSlotCount >= 2, "double buffering is required");
static_assert(static_cast<uint32_t>(WriterState::kLive) == 1u,
              "writer state values are part of the wire contract");

}  // namespace
