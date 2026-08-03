const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const mediaSource = read('native/camera-companion/src/source/media_source.cpp');
const mediaSourceHeader = read('native/camera-companion/src/source/media_source.h');
const activation = read('native/camera-companion/src/source/media_source_activate.cpp');
const frameSource = read('native/camera-companion/src/source/frame_source.h');
const mediaStream = read('native/camera-companion/src/source/media_stream.cpp');
const mediaStreamHeader = read('native/camera-companion/src/source/media_stream.h');
const host = read('native/camera-companion/src/host/main.cpp');

test('the first custom-camera stream uses the mandatory zero-based ID', () => {
  assert.match(mediaSource, /constexpr\s+DWORD\s+kStreamId\s*=\s*0\s*;/);
  assert.doesNotMatch(mediaSource, /streamId\s*!=\s*kStreamId\s*&&/);
});

test('the activation object copies all Frame Server attributes into the source', () => {
  assert.match(
    mediaSourceHeader,
    /CreateInstance\(IMFAttributes\*\s*activationAttributes,\s*MediaSource\*\*\s*out\)/,
  );
  assert.match(
    mediaSource,
    /activationAttributes->CopyAllItems\(source->source_attributes_\.Get\(\)\)/,
  );
  assert.match(activation, /MediaSource::CreateInstance\(attributes_\.Get\(\),\s*&raw\)/);
});

test('separate IMFActivate lifecycle methods follow the Frame Server contract', () => {
  assert.match(
    activation,
    /HRESULT\s+MediaSourceActivate::ShutdownObject\(\)\s*\{\s*return\s+E_NOTIMPL;\s*\}/s,
  );
  assert.match(
    activation,
    /HRESULT\s+MediaSourceActivate::DetachObject\(\)\s*\{\s*return\s+E_NOTIMPL;\s*\}/s,
  );
});

test('camera samples use the Media Foundation system timebase', () => {
  assert.match(frameSource, /MFGetSystemTime\(\)/);
  assert.doesNotMatch(frameSource, /next_time_\s*=\s*0/);
});

test('sample delivery is paced by the negotiated frame deadline', () => {
  assert.match(frameSource, /void WaitForFrameDeadline\(\)/);
  assert.match(mediaStream, /frames_\.WaitForFrameDeadline\(\);[\s\S]*frames_\.WriteFrame/);
});

test('frames are written through a two-dimensional buffer, never a flat one', () => {
  // Stride correctness, unchanged in intent. The buffer now comes from the
  // Frame Server's allocator rather than MFCreate2DMediaBuffer, but writing
  // still goes through IMF2DBuffer so row padding is honoured.
  assert.match(mediaStream, /ComPtr<IMF2DBuffer>\s+buffer2d/);
  assert.match(mediaStream, /buffer2d->ContiguousCopyFrom\(/);
  assert.doesNotMatch(mediaStream, /MFCreateMemoryBuffer\(payload_bytes/);
});

// The W4 blank feed was exactly this: the source allocated its own buffers, which
// are process-local, so the Frame Server could not forward them to a consumer and
// abandoned the pipeline after activation. Microsoft's reference camera differs
// from ours in this interface and nothing else, and it streams. Regressing any of
// these puts the camera back to enumerating but delivering no frames.
test('the media source offers IMFSampleAllocatorControl to the Frame Server', () => {
  assert.match(mediaSourceHeader, /public\s+IMFSampleAllocatorControl/);
  assert.match(mediaSource, /iid\s*==\s*__uuidof\(IMFSampleAllocatorControl\)/);
  assert.match(mediaSource, /MediaSource::SetDefaultAllocator\(/);
  assert.match(mediaSource, /MediaSource::GetAllocatorUsage\(/);
});

test('the source requests a server-provided allocator rather than its own', () => {
  assert.match(mediaStreamHeader, /MFSampleAllocatorUsage_UsesProvidedAllocator/);
  // Creating our own allocator would defeat the handshake: the server would have
  // no way to hand us shareable memory.
  assert.doesNotMatch(mediaStream, /MFCreateVideoSampleAllocator/);
});

test('every delivered sample is allocated from the provided allocator', () => {
  assert.match(mediaStream, /allocator_->AllocateSample\(/);
  assert.doesNotMatch(mediaStream, /MFCreateSample\(/);
});

test('a missing allocator fails loudly instead of falling back', () => {
  // A silent fallback to process-local buffers would reproduce the original
  // stall while looking healthy in-process.
  assert.match(
    mediaStream,
    /if\s*\(!allocator_\)\s*\{[\s\S]*?return\s+MF_E_NOT_INITIALIZED;/,
  );
});

test('the allocator is rebound when the consumer renegotiates the format', () => {
  // An allocator bound to NV12 hands out buffers too small for RGB32.
  assert.match(mediaStream, /allocator_initialized_\s*&&\s*allocator_format_\s*==\s*format/);
  assert.match(mediaStream, /allocator_->UninitializeSampleAllocator\(\)/);
});

test('the in-process harness performs the allocator handshake it used to skip', () => {
  // `drive` passed for weeks while the real camera delivered nothing, because
  // in-process activation never involves the Frame Server. If the harness stops
  // playing the server's role it stops being able to catch this class of bug.
  assert.match(host, /QueryInterface\(__uuidof\(IMFSampleAllocatorControl\)/);
  assert.match(host, /GetAllocatorUsage\(0,/);
  assert.match(host, /SetDefaultAllocator\(0,/);
});
