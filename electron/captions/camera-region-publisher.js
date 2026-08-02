const fs = require('node:fs/promises');
const path = require('node:path');

const {
  FrameWriter,
  HEADER_BYTES,
  OFFSET,
  WRITER_STATE,
  allocateBuffer,
  computeGeometry,
} = require('./camera-frame-transport');

function defaultCameraRegionPath(programData = process.env.ProgramData) {
  const root = programData || 'C:\\ProgramData';
  return path.win32.join(
    root,
    'Twinscript',
    'runtime',
    'camera-frame-v1.bin',
  );
}

async function writeAllAt(handle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(
      buffer,
      written,
      buffer.length - written,
      position + written,
    );
    if (!result || result.bytesWritten <= 0) {
      throw new Error(`Camera frame region write stopped after ${written} bytes`);
    }
    written += result.bytesWritten;
  }
}

class CameraRegionPublisher {
  constructor({
    regionPath = defaultCameraRegionPath(),
    width,
    height,
    frameRate,
    slotCount,
    openFile = (filePath, flags) => fs.open(filePath, flags),
    ensureDirectory = (directory) => fs.mkdir(directory, { recursive: true }),
  } = {}) {
    this.regionPath = regionPath;
    this.frameRate = frameRate;
    this.geometryOptions = { width, height, slotCount };
    this.geometry = computeGeometry(this.geometryOptions);
    this.openFile = openFile;
    this.ensureDirectory = ensureDirectory;
    this.handle = null;
    this.sequence = 0n;
    this.pending = null;
    this.drainPromise = null;
    this.closing = false;
    this.publishedFrames = 0;
    this.droppedFrames = 0;
  }

  async start() {
    if (this.handle) return;
    await this.ensureDirectory(path.dirname(this.regionPath));
    const handle = await this.openFile(this.regionPath, 'w+');
    try {
      await handle.truncate(this.geometry.totalBytes);

      const initialized = allocateBuffer(this.geometryOptions);
      new FrameWriter({
        buffer: initialized,
        ...this.geometryOptions,
        frameRate: this.frameRate,
      });
      await writeAllAt(handle, initialized.subarray(0, HEADER_BYTES), 0);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    this.handle = handle;
    this.sequence = 0n;
    this.pending = null;
    this.drainPromise = null;
    this.closing = false;
  }

  publish(payload, capturedAtMonotonicNs = process.hrtime.bigint()) {
    if (!this.handle || this.closing) {
      return Promise.reject(new Error('Camera frame publisher is not running'));
    }
    if (!payload || payload.length !== this.geometry.payloadBytes) {
      return Promise.reject(
        new Error(
          `Camera frame must contain exactly ${this.geometry.payloadBytes} bytes`,
        ),
      );
    }

    const frame = {
      payload: Buffer.from(payload),
      capturedAtMonotonicNs: BigInt(capturedAtMonotonicNs),
    };
    if (this.pending) this.droppedFrames += 1;
    this.pending = frame;
    if (!this.drainPromise) {
      this.drainPromise = this.#drain().finally(() => {
        this.drainPromise = null;
      });
    }
    return this.drainPromise;
  }

  async #drain() {
    while (this.pending) {
      const frame = this.pending;
      this.pending = null;
      await this.#writeFrame(frame);
    }
  }

  async #writeFrame({ payload, capturedAtMonotonicNs }) {
    const next = this.sequence + 1n;
    const slot = Number(next % BigInt(this.geometry.slotCount));
    await writeAllAt(this.handle, payload, this.geometry.slotOffset(slot));

    const timestamp = Buffer.allocUnsafe(8);
    timestamp.writeBigUInt64LE(capturedAtMonotonicNs);
    await writeAllAt(this.handle, timestamp, OFFSET.capturedAtMonotonicNs);

    const state = Buffer.allocUnsafe(4);
    state.writeUInt32LE(WRITER_STATE.live);
    await writeAllAt(this.handle, state, OFFSET.writerState);

    const sequence = Buffer.allocUnsafe(8);
    sequence.writeBigUInt64LE(next);
    await writeAllAt(this.handle, sequence, OFFSET.frameSequence);
    this.sequence = next;
    this.publishedFrames += 1;
  }

  async #setState(state) {
    if (!this.handle) return;
    if (this.drainPromise) await this.drainPromise;
    const encoded = Buffer.allocUnsafe(4);
    encoded.writeUInt32LE(state);
    await writeAllAt(this.handle, encoded, OFFSET.writerState);
  }

  /**
   * Re-stamp the published frame as current without rewriting its pixels.
   *
   * Offscreen `paint` events are change-driven: a caption stage with nothing
   * moving stops painting entirely, so publication stops and the native reader
   * expires the region after its two-second repeat limit and shows a slate. That
   * blanks the feed while idle and, worse, during any mid-meeting pause between
   * utterances.
   *
   * A real camera pointed at a static scene keeps delivering frames, so the
   * region has to keep saying "still current". Only the timestamp is written —
   * eight bytes rather than re-pushing an 8.3 MB payload — and the sequence is
   * left alone so the reader takes its "unchanged sequence repeats" path and
   * redelivers the frame it already has.
   */
  async touch(capturedAtMonotonicNs = process.hrtime.bigint()) {
    if (!this.handle || this.closing) return false;
    if (this.sequence === 0n) return false; // nothing published yet
    if (this.drainPromise) await this.drainPromise;
    if (!this.handle || this.closing) return false;
    const timestamp = Buffer.allocUnsafe(8);
    timestamp.writeBigUInt64LE(BigInt(capturedAtMonotonicNs));
    await writeAllAt(this.handle, timestamp, OFFSET.capturedAtMonotonicNs);
    return true;
  }

  async setIdle() {
    await this.#setState(WRITER_STATE.idle);
  }

  async stop() {
    if (!this.handle) return;
    this.closing = true;
    if (this.drainPromise) await this.drainPromise;
    await this.#setState(WRITER_STATE.stopped);
    const handle = this.handle;
    this.handle = null;
    await handle.close();
  }

  metrics() {
    return {
      publishedFrames: this.publishedFrames,
      droppedFrames: this.droppedFrames,
    };
  }
}

module.exports = {
  CameraRegionPublisher,
  defaultCameraRegionPath,
  writeAllAt,
};
