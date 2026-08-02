const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_FRAME_RATE,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  FrameReader,
  FrameWriter,
  HEADER_BYTES,
  LAST_FRAME_REPEAT_LIMIT_NS,
  MAGIC,
  OFFSET,
  PIXEL_FORMAT,
  PROTOCOL_VERSION,
  WRITER_STATE,
  allocateBuffer,
  computeGeometry,
  isFrameExpired,
  readHeader,
} = require('./camera-frame-transport');

// A small frame keeps the tests fast; the protocol is size-independent.
const SMALL = { width: 4, height: 2 };

function smallWriter(overrides = {}) {
  const buffer = allocateBuffer({ ...SMALL, ...overrides });
  return { buffer, writer: new FrameWriter({ buffer, ...SMALL, ...overrides }) };
}

function frameOf(byte, options = SMALL) {
  return Buffer.alloc(computeGeometry(options).payloadBytes, byte);
}

test('geometry matches the documented 1920x1080 BGRA8 default', () => {
  const geometry = computeGeometry();
  assert.equal(geometry.width, DEFAULT_WIDTH);
  assert.equal(geometry.height, DEFAULT_HEIGHT);
  assert.equal(geometry.pixelFormat, PIXEL_FORMAT.BGRA8);
  assert.equal(geometry.stride, 1920 * 4);
  assert.equal(geometry.payloadBytes, 1920 * 1080 * 4);
  assert.equal(geometry.slotCount, 2, 'double buffering');
  assert.equal(geometry.totalBytes, HEADER_BYTES + 1920 * 1080 * 4 * 2);
  // Slots must not overlap the header or each other.
  assert.equal(geometry.slotOffset(0), HEADER_BYTES);
  assert.equal(geometry.slotOffset(1), HEADER_BYTES + geometry.payloadBytes);
});

test('the header keeps its 8-byte fields 8-byte aligned so their stores stay atomic', () => {
  assert.equal(OFFSET.capturedAtMonotonicNs % 8, 0);
  assert.equal(OFFSET.frameSequence % 8, 0);
  assert.ok(OFFSET.frameSequence + 8 <= HEADER_BYTES);
});

test('geometry rejects shapes the protocol cannot express', () => {
  assert.throws(() => computeGeometry({ width: 0 }), /positive integer/);
  assert.throws(() => computeGeometry({ height: -1 }), /positive integer/);
  assert.throws(() => computeGeometry({ width: 1.5 }), /positive integer/);
  assert.throws(() => computeGeometry({ slotCount: 1 }), /at least 2/);
  assert.throws(() => computeGeometry({ pixelFormat: 999 }), /Unsupported pixel format/);
});

test('a fresh writer advertises the format and starts in the starting state', () => {
  const { buffer } = smallWriter();
  const header = readHeader(buffer);
  assert.equal(header.magic, MAGIC);
  assert.equal(header.protocolVersion, PROTOCOL_VERSION);
  assert.equal(header.width, 4);
  assert.equal(header.height, 2);
  assert.equal(header.stride, 16);
  assert.equal(header.payloadBytes, 32);
  assert.equal(header.frameRate, DEFAULT_FRAME_RATE);
  assert.equal(header.writerStateName, 'starting');
  assert.equal(header.frameSequence, 0n);
});

test('a reader reports no-frame before the first publish', () => {
  const { buffer } = smallWriter();
  assert.deepEqual(new FrameReader(buffer).read(), { ok: false, reason: 'no-frame' });
});

test('a published frame round-trips with its sequence and timestamp', () => {
  const { buffer, writer } = smallWriter();
  const reader = new FrameReader(buffer);

  const sequence = writer.writeFrame(frameOf(0xab), 123_456_789n);

  assert.equal(sequence, 1n);
  const result = reader.read();
  assert.equal(result.ok, true);
  assert.equal(result.fresh, true);
  assert.equal(result.sequence, 1n);
  assert.equal(result.capturedAtMonotonicNs, 123_456_789n);
  assert.deepEqual(result.payload, frameOf(0xab));
  // Publishing a frame implies the writer is live.
  assert.equal(readHeader(buffer).writerStateName, 'live');
});

test('consecutive frames alternate slots so a reader never races the slot being written', () => {
  const { buffer, writer } = smallWriter();
  const reader = new FrameReader(buffer);
  const slots = [];
  for (let i = 1; i <= 6; i += 1) {
    writer.writeFrame(frameOf(i), BigInt(i) * 1000n);
    slots.push(reader.read().slot);
  }
  assert.deepEqual(slots, [1, 0, 1, 0, 1, 0]);
});

test('a re-read of an unadvanced sequence is reported as a repeat, not a new frame', () => {
  const { buffer, writer } = smallWriter();
  const reader = new FrameReader(buffer);
  writer.writeFrame(frameOf(7), 1000n);

  const first = reader.read();
  const second = reader.read();

  assert.equal(first.fresh, true);
  assert.equal(first.reason, 'fresh');
  assert.equal(second.ok, true);
  assert.equal(second.fresh, false);
  assert.equal(second.reason, 'repeat');
  assert.equal(second.sequence, first.sequence);
});

test('a frame published mid-read is detected as torn instead of returned half-copied', () => {
  const { buffer, writer } = smallWriter();
  const reader = new FrameReader(buffer);
  writer.writeFrame(frameOf(0x11), 1000n);

  // Simulate the writer lapping the reader between the pre- and post-check by
  // publishing during the payload copy.
  const realSubarray = buffer.subarray.bind(buffer);
  let interfered = false;
  buffer.subarray = (...args) => {
    if (!interfered) {
      interfered = true;
      writer.writeFrame(frameOf(0x22), 2000n);
    }
    return realSubarray(...args);
  };
  try {
    assert.deepEqual(reader.read(), { ok: false, reason: 'torn' });
  } finally {
    buffer.subarray = realSubarray;
  }

  // A retry after the writer settles succeeds and yields the newer frame.
  const retry = reader.read();
  assert.equal(retry.ok, true);
  assert.equal(retry.sequence, 2n);
  assert.deepEqual(retry.payload, frameOf(0x22));
});

test('the sequence is published last, so a filled slot is invisible until then', () => {
  const { buffer, writer } = smallWriter();
  const writes = [];
  const realWriteBigUInt64LE = buffer.writeBigUInt64LE.bind(buffer);
  buffer.writeBigUInt64LE = (value, offset) => {
    writes.push(offset);
    return realWriteBigUInt64LE(value, offset);
  };
  const realSet = buffer.set.bind(buffer);
  buffer.set = (...args) => {
    writes.push('payload');
    return realSet(...args);
  };
  try {
    writer.writeFrame(frameOf(1), 500n);
  } finally {
    buffer.writeBigUInt64LE = realWriteBigUInt64LE;
    buffer.set = realSet;
  }
  assert.equal(
    writes.at(-1),
    OFFSET.frameSequence,
    'the frame sequence must be the final store of writeFrame',
  );
  assert.ok(writes.indexOf('payload') < writes.length - 1);
});

test('a payload of the wrong size is rejected rather than silently truncated', () => {
  const { writer } = smallWriter();
  assert.throws(() => writer.writeFrame(Buffer.alloc(31), 0n), /exactly 32 bytes/);
  assert.throws(() => writer.writeFrame(Buffer.alloc(33), 0n), /exactly 32 bytes/);
});

test('a buffer too small for the declared geometry is refused at construction', () => {
  assert.throws(
    () => new FrameWriter({ buffer: Buffer.alloc(HEADER_BYTES), ...SMALL }),
    /at least/,
  );
});

test('writer states are named and round-trip through the header', () => {
  const { buffer, writer } = smallWriter();
  for (const [name, value] of Object.entries(WRITER_STATE)) {
    writer.setState(value);
    assert.equal(readHeader(buffer).writerStateName, name);
  }
  assert.throws(() => writer.setState(42), /Unknown writer state/);
});

test('a reader rejects a buffer that is not a frame region', () => {
  const notAFrameBuffer = Buffer.alloc(256);
  assert.throws(() => readHeader(notAFrameBuffer), /not a camera frame buffer/);
  assert.throws(() => readHeader(Buffer.alloc(8)), /smaller than the frame header/);
});

test('a future protocol version is rejected loudly instead of misread', () => {
  const { buffer } = smallWriter();
  buffer.writeUInt32LE(PROTOCOL_VERSION + 1, OFFSET.protocolVersion);
  assert.throws(() => readHeader(buffer), /unsupported frame protocol version/);
  assert.throws(() => new FrameReader(buffer), /unsupported frame protocol version/);
});

test('frame expiry implements the two-second last-frame repeat limit', () => {
  const captured = 10_000_000_000n;
  assert.equal(isFrameExpired(captured, captured), false);
  assert.equal(isFrameExpired(captured, captured + LAST_FRAME_REPEAT_LIMIT_NS), false);
  assert.equal(isFrameExpired(captured, captured + LAST_FRAME_REPEAT_LIMIT_NS + 1n), true);
});

test('a backwards clock reading is treated as jitter, not expiry', () => {
  assert.equal(isFrameExpired(10_000n, 9_000n), false);
});

test('a full-size 1920x1080 frame publishes and reads back intact', () => {
  const buffer = allocateBuffer();
  const writer = new FrameWriter({ buffer });
  const reader = new FrameReader(buffer);
  const payload = Buffer.alloc(computeGeometry().payloadBytes);
  // Mark the corners so a stride or offset error cannot pass unnoticed.
  payload.writeUInt32LE(0xdeadbeef, 0);
  payload.writeUInt32LE(0xfeedface, payload.length - 4);

  writer.writeFrame(payload, 42n);
  const result = reader.read();

  assert.equal(result.ok, true);
  assert.equal(result.payload.length, 1920 * 1080 * 4);
  assert.equal(result.payload.readUInt32LE(0), 0xdeadbeef);
  assert.equal(result.payload.readUInt32LE(result.payload.length - 4), 0xfeedface);
});

test('a 30 fps configuration is advertised to the companion', () => {
  const { buffer } = smallWriter({ frameRate: 30 });
  assert.equal(readHeader(buffer).frameRate, 30);
});

// ---------------------------------------------------------------------------
// Cross-language drift guard
// ---------------------------------------------------------------------------
//
// The C++ companion describes the same bytes in its own header. Nothing at
// runtime would catch a divergence — Electron would publish frames the companion
// reads at the wrong offsets, producing a scrambled camera feed rather than an
// error. This test is the only thing that fails when the two drift apart.

const fs = require('node:fs');
const path = require('node:path');

const cppHeaderPath = path.resolve(
  __dirname,
  '..',
  '..',
  'native',
  'camera-companion',
  'include',
  'frame_transport.h',
);

function cppConstant(source, name) {
  const match = source.match(
    new RegExp(`constexpr\\s+(?:uint32_t|uint64_t)\\s+${name}\\s*=\\s*([0-9a-fA-Fx]+)(?:ULL)?\\s*;`),
  );
  assert.ok(match, `native header must define ${name}`);
  return BigInt(match[1]);
}

test('the native header agrees with the JS frame contract', () => {
  assert.ok(
    fs.existsSync(cppHeaderPath),
    'native/camera-companion/include/frame_transport.h must exist',
  );
  const source = fs.readFileSync(cppHeaderPath, 'utf8');

  assert.equal(cppConstant(source, 'kMagic'), BigInt(MAGIC));
  assert.equal(cppConstant(source, 'kProtocolVersion'), BigInt(PROTOCOL_VERSION));
  assert.equal(cppConstant(source, 'kPixelFormatBgra8'), BigInt(PIXEL_FORMAT.BGRA8));
  assert.equal(cppConstant(source, 'kHeaderBytes'), BigInt(HEADER_BYTES));
  assert.equal(cppConstant(source, 'kDefaultWidth'), BigInt(DEFAULT_WIDTH));
  assert.equal(cppConstant(source, 'kDefaultHeight'), BigInt(DEFAULT_HEIGHT));
  assert.equal(cppConstant(source, 'kDefaultFrameRate'), BigInt(DEFAULT_FRAME_RATE));
  assert.equal(
    cppConstant(source, 'kLastFrameRepeatLimitNs'),
    LAST_FRAME_REPEAT_LIMIT_NS,
  );

  // Every JS offset must have an identical native counterpart.
  const nativeOffsetNames = {
    magic: 'kOffsetMagic',
    protocolVersion: 'kOffsetProtocolVersion',
    width: 'kOffsetWidth',
    height: 'kOffsetHeight',
    pixelFormat: 'kOffsetPixelFormat',
    stride: 'kOffsetStride',
    payloadBytes: 'kOffsetPayloadBytes',
    slotCount: 'kOffsetSlotCount',
    writerState: 'kOffsetWriterState',
    frameRate: 'kOffsetFrameRate',
    capturedAtMonotonicNs: 'kOffsetCapturedAtMonotonicNs',
    frameSequence: 'kOffsetFrameSequence',
  };
  for (const [jsField, nativeName] of Object.entries(nativeOffsetNames)) {
    assert.equal(
      cppConstant(source, nativeName),
      BigInt(OFFSET[jsField]),
      `${nativeName} must match OFFSET.${jsField}`,
    );
  }
  assert.deepEqual(
    Object.keys(OFFSET).sort(),
    Object.keys(nativeOffsetNames).sort(),
    'a new JS header field needs a native counterpart in this map',
  );
});

test('the native writer-state enum agrees with the JS one', () => {
  const source = fs.readFileSync(cppHeaderPath, 'utf8');
  const expected = {
    kStarting: WRITER_STATE.starting,
    kLive: WRITER_STATE.live,
    kIdle: WRITER_STATE.idle,
    kStopped: WRITER_STATE.stopped,
  };
  for (const [nativeName, value] of Object.entries(expected)) {
    const match = source.match(new RegExp(`${nativeName}\\s*=\\s*(\\d+)`));
    assert.ok(match, `native header must define WriterState::${nativeName}`);
    assert.equal(Number(match[1]), value, `${nativeName} must equal ${value}`);
  }
});
