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

test('known uncompressed video types use two-dimensional media buffers', () => {
  assert.match(mediaStream, /MFCreate2DMediaBuffer\(/);
  assert.doesNotMatch(mediaStream, /MFCreateMemoryBuffer\(payload_bytes/);
});
