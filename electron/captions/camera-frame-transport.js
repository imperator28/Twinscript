// The shared-memory frame contract between Electron and the native camera
// companion (W4).
//
// Frames must never travel as one IPC message each: at 1920x1080 BGRA8 a single
// frame is ~8 MB, and 15-30 of them per second through Electron's structured
// clone would dominate the main process. IPC carries lifecycle and health only;
// pixels go through a shared memory region whose layout is pinned here so the
// C++ side and the JS side cannot silently disagree.
//
// This module owns the *format and protocol*, not the mapping. `buffer` is any
// object with Node Buffer semantics — a plain Buffer in tests, a mapped view of
// a Windows section object in production. Keeping the codec independent of the
// mapping is what lets the protocol be tested without a native addon.
//
// Concurrency: a seqlock over N slots. The writer fills the slot for sequence
// S+1, then publishes S+1 with a single aligned 8-byte store as the last
// operation. A reader samples the sequence, copies the slot, then re-samples the
// sequence; a change means the writer lapped it mid-copy and the read is
// discarded. No locks, and a stalled reader can never block the frame clock.

const MAGIC = 0x464d4342; // 'BMCF' little-endian: Twinscript Frames
const PROTOCOL_VERSION = 1;

const PIXEL_FORMAT = Object.freeze({ BGRA8: 1 });
const BYTES_PER_PIXEL = Object.freeze({ [PIXEL_FORMAT.BGRA8]: 4 });

// `stopped` is distinct from `idle`: idle means "the writer is alive but has
// nothing to show" (between sessions), stopped means "the writer is gone".
// The companion shows the privacy slate for both but only retries for idle.
const WRITER_STATE = Object.freeze({
  starting: 0,
  live: 1,
  idle: 2,
  stopped: 3,
});
const WRITER_STATE_NAME = Object.freeze(
  Object.fromEntries(Object.entries(WRITER_STATE).map(([name, value]) => [value, name])),
);

// Field offsets. Fixed forever for protocol version 1; a layout change requires
// a new PROTOCOL_VERSION, which an older reader rejects rather than
// misinterprets. 64 bytes keeps the header on one cache line, and the two
// 8-byte fields land on 8-byte boundaries so their stores are atomic on x64.
const OFFSET = Object.freeze({
  magic: 0,
  protocolVersion: 4,
  width: 8,
  height: 12,
  pixelFormat: 16,
  stride: 20,
  payloadBytes: 24,
  slotCount: 28,
  writerState: 32,
  frameRate: 36,
  capturedAtMonotonicNs: 40,
  frameSequence: 48,
});
const HEADER_BYTES = 64;

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FRAME_RATE = 15; // configurable to 30; 15 is enough for caption motion
const DEFAULT_SLOT_COUNT = 2; // double buffering

// The companion repeats the newest valid frame when Electron misses a deadline,
// but only for so long — after this it shows a neutral disconnected slate rather
// than a frozen meeting transcript that looks live.
const LAST_FRAME_REPEAT_LIMIT_NS = 2_000_000_000n;

/**
 * Byte geometry for a given frame size. `stride` is tight-packed: the renderer
 * hands us contiguous BGRA, and a padded stride would only add a copy.
 */
function computeGeometry({
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  pixelFormat = PIXEL_FORMAT.BGRA8,
  slotCount = DEFAULT_SLOT_COUNT,
} = {}) {
  const bytesPerPixel = BYTES_PER_PIXEL[pixelFormat];
  if (!bytesPerPixel) throw new Error(`Unsupported pixel format: ${pixelFormat}`);
  if (!Number.isInteger(width) || width <= 0) throw new Error('width must be a positive integer');
  if (!Number.isInteger(height) || height <= 0) throw new Error('height must be a positive integer');
  if (!Number.isInteger(slotCount) || slotCount < 2) {
    throw new Error('slotCount must be at least 2 for double buffering');
  }
  const stride = width * bytesPerPixel;
  const payloadBytes = stride * height;
  return {
    width,
    height,
    pixelFormat,
    slotCount,
    stride,
    payloadBytes,
    headerBytes: HEADER_BYTES,
    totalBytes: HEADER_BYTES + payloadBytes * slotCount,
    slotOffset: (slot) => HEADER_BYTES + payloadBytes * slot,
  };
}

/** Allocate a correctly sized backing buffer. Production maps a section instead. */
function allocateBuffer(options) {
  return Buffer.alloc(computeGeometry(options).totalBytes);
}

class FrameWriter {
  /**
   * @param {object} options
   * @param {Buffer} options.buffer backing store, at least `totalBytes` long
   */
  constructor({ buffer, frameRate = DEFAULT_FRAME_RATE, ...geometryOptions } = {}) {
    this.geometry = computeGeometry(geometryOptions);
    if (!buffer || buffer.length < this.geometry.totalBytes) {
      throw new Error(
        `buffer must be at least ${this.geometry.totalBytes} bytes for ` +
          `${this.geometry.width}x${this.geometry.height}`,
      );
    }
    this.buffer = buffer;
    this.frameRate = frameRate;
    this.sequence = 0n;

    const { width, height, pixelFormat, stride, payloadBytes, slotCount } = this.geometry;
    buffer.writeUInt32LE(MAGIC, OFFSET.magic);
    buffer.writeUInt32LE(PROTOCOL_VERSION, OFFSET.protocolVersion);
    buffer.writeUInt32LE(width, OFFSET.width);
    buffer.writeUInt32LE(height, OFFSET.height);
    buffer.writeUInt32LE(pixelFormat, OFFSET.pixelFormat);
    buffer.writeUInt32LE(stride, OFFSET.stride);
    buffer.writeUInt32LE(payloadBytes, OFFSET.payloadBytes);
    buffer.writeUInt32LE(slotCount, OFFSET.slotCount);
    buffer.writeUInt32LE(frameRate, OFFSET.frameRate);
    buffer.writeBigUInt64LE(0n, OFFSET.capturedAtMonotonicNs);
    buffer.writeBigUInt64LE(0n, OFFSET.frameSequence);
    this.setState(WRITER_STATE.starting);
  }

  setState(state) {
    if (!Object.hasOwn(WRITER_STATE_NAME, state)) {
      throw new Error(`Unknown writer state: ${state}`);
    }
    this.buffer.writeUInt32LE(state, OFFSET.writerState);
    return state;
  }

  /**
   * Publish one frame. Returns the published sequence number.
   *
   * The payload copy happens into the slot the *next* sequence maps to, which is
   * never the slot a reader could currently be reading from — that is the whole
   * point of the second slot. Only after the copy completes is the sequence
   * advanced, and that store is what makes the frame visible.
   */
  writeFrame(payload, capturedAtMonotonicNs) {
    const { payloadBytes, slotCount, slotOffset } = this.geometry;
    if (payload.length !== payloadBytes) {
      throw new Error(`frame payload must be exactly ${payloadBytes} bytes, got ${payload.length}`);
    }
    const next = this.sequence + 1n;
    const slot = Number(next % BigInt(slotCount));
    this.buffer.set(payload, slotOffset(slot));
    this.buffer.writeBigUInt64LE(
      BigInt(capturedAtMonotonicNs),
      OFFSET.capturedAtMonotonicNs,
    );
    this.buffer.writeUInt32LE(WRITER_STATE.live, OFFSET.writerState);
    // Publication barrier: everything above must be visible before the sequence
    // advances, and this store must be last.
    this.buffer.writeBigUInt64LE(next, OFFSET.frameSequence);
    this.sequence = next;
    return next;
  }
}

/**
 * Read the header without copying a frame. Throws on a magic or version
 * mismatch so a mismatched companion fails loudly at startup instead of
 * rendering garbage.
 */
function readHeader(buffer) {
  if (buffer.length < HEADER_BYTES) throw new Error('buffer is smaller than the frame header');
  const magic = buffer.readUInt32LE(OFFSET.magic);
  if (magic !== MAGIC) {
    throw new Error(
      `not a camera frame buffer (magic 0x${magic.toString(16)}, expected 0x${MAGIC.toString(16)})`,
    );
  }
  const protocolVersion = buffer.readUInt32LE(OFFSET.protocolVersion);
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `unsupported frame protocol version ${protocolVersion} (this build speaks ${PROTOCOL_VERSION})`,
    );
  }
  const writerState = buffer.readUInt32LE(OFFSET.writerState);
  return {
    magic,
    protocolVersion,
    width: buffer.readUInt32LE(OFFSET.width),
    height: buffer.readUInt32LE(OFFSET.height),
    pixelFormat: buffer.readUInt32LE(OFFSET.pixelFormat),
    stride: buffer.readUInt32LE(OFFSET.stride),
    payloadBytes: buffer.readUInt32LE(OFFSET.payloadBytes),
    slotCount: buffer.readUInt32LE(OFFSET.slotCount),
    frameRate: buffer.readUInt32LE(OFFSET.frameRate),
    writerState,
    writerStateName: WRITER_STATE_NAME[writerState] || 'unknown',
    capturedAtMonotonicNs: buffer.readBigUInt64LE(OFFSET.capturedAtMonotonicNs),
    frameSequence: buffer.readBigUInt64LE(OFFSET.frameSequence),
  };
}

class FrameReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.header = readHeader(buffer);
    this.lastSequence = 0n;
  }

  /**
   * Attempt one consistent read.
   *
   * Returns `{ ok: false, reason }` rather than throwing, because every failure
   * mode here is expected at least occasionally: `no-frame` before the first
   * publish, `torn` when the writer lapped mid-copy (retry), and `stale` when
   * the sequence has not advanced (the companion repeats its last frame).
   */
  read({ copy = true } = {}) {
    const { payloadBytes, slotCount } = this.header;
    const sequenceBefore = this.buffer.readBigUInt64LE(OFFSET.frameSequence);
    if (sequenceBefore === 0n) return { ok: false, reason: 'no-frame' };

    const slot = Number(sequenceBefore % BigInt(slotCount));
    const offset = HEADER_BYTES + payloadBytes * slot;
    const capturedAtMonotonicNs = this.buffer.readBigUInt64LE(OFFSET.capturedAtMonotonicNs);
    const view = this.buffer.subarray(offset, offset + payloadBytes);
    const payload = copy ? Buffer.from(view) : view;

    const sequenceAfter = this.buffer.readBigUInt64LE(OFFSET.frameSequence);
    if (sequenceAfter !== sequenceBefore) return { ok: false, reason: 'torn' };

    const fresh = sequenceBefore !== this.lastSequence;
    this.lastSequence = sequenceBefore;
    return {
      ok: true,
      fresh,
      reason: fresh ? 'fresh' : 'repeat',
      sequence: sequenceBefore,
      slot,
      capturedAtMonotonicNs,
      payload,
    };
  }
}

/**
 * Whether a frame is too old to keep showing.
 *
 * The companion repeats the newest valid frame across a missed deadline, but a
 * frozen transcript that still looks live is worse than an honest slate, so
 * after the limit the caller switches to the disconnected slate.
 */
function isFrameExpired(capturedAtMonotonicNs, nowMonotonicNs, limitNs = LAST_FRAME_REPEAT_LIMIT_NS) {
  const captured = BigInt(capturedAtMonotonicNs);
  const now = BigInt(nowMonotonicNs);
  if (now <= captured) return false; // clock jitter, not expiry
  return now - captured > BigInt(limitNs);
}

module.exports = {
  MAGIC,
  PROTOCOL_VERSION,
  PIXEL_FORMAT,
  WRITER_STATE,
  WRITER_STATE_NAME,
  OFFSET,
  HEADER_BYTES,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  DEFAULT_FRAME_RATE,
  DEFAULT_SLOT_COUNT,
  LAST_FRAME_REPEAT_LIMIT_NS,
  computeGeometry,
  allocateBuffer,
  readHeader,
  isFrameExpired,
  FrameWriter,
  FrameReader,
};
