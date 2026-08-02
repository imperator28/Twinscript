const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FrameReader,
  HEADER_BYTES,
  OFFSET,
  WRITER_STATE,
  computeGeometry,
  readHeader,
} = require('./camera-frame-transport');
const { CameraRegionPublisher } = require('./camera-region-publisher');

const SMALL = { width: 4, height: 2, frameRate: 15 };

test('preallocates the region and publishes a sequence-last coherent frame', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-camera-region-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const regionPath = path.join(directory, 'frame.bin');
  const publisher = new CameraRegionPublisher({ regionPath, ...SMALL });
  await publisher.start();

  const geometry = computeGeometry(SMALL);
  assert.equal((await fs.stat(regionPath)).size, geometry.totalBytes);
  await publisher.publish(Buffer.alloc(geometry.payloadBytes, 0x4b), 123_456n);
  await publisher.stop();

  const region = await fs.readFile(regionPath);
  const header = readHeader(region);
  assert.equal(header.writerState, WRITER_STATE.stopped);
  assert.equal(header.frameSequence, 1n);
  const frame = new FrameReader(region).read();
  assert.equal(frame.ok, true);
  assert.equal(frame.capturedAtMonotonicNs, 123_456n);
  assert.equal(frame.payload.every((byte) => byte === 0x4b), true);
});

test('writes payload, timestamp, state, then sequence for each publication', async () => {
  const writes = [];
  const handle = {
    truncate: async () => {},
    write: async (buffer, offset, length, position) => {
      writes.push({ position, bytes: Buffer.from(buffer.subarray(offset, offset + length)) });
      return { bytesWritten: length };
    },
    close: async () => {},
  };
  const publisher = new CameraRegionPublisher({
    ...SMALL,
    regionPath: 'ignored',
    ensureDirectory: async () => {},
    openFile: async () => handle,
  });
  await publisher.start();
  const geometry = computeGeometry(SMALL);
  await publisher.publish(Buffer.alloc(geometry.payloadBytes, 7), 999n);

  assert.deepEqual(
    writes.slice(1).map((write) => write.position),
    [geometry.slotOffset(1), OFFSET.capturedAtMonotonicNs, OFFSET.writerState,
      OFFSET.frameSequence],
  );
  assert.equal(writes.at(-1).position, OFFSET.frameSequence);
});

test('keeps only the newest pending frame under writer backpressure', async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let payloadWrites = 0;
  const payloadValues = [];
  const geometry = computeGeometry(SMALL);
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  const handle = {
    truncate: async () => {},
    write: async (buffer, offset, length, position) => {
      if (length === geometry.payloadBytes) {
        payloadWrites += 1;
        payloadValues.push(buffer[offset]);
        if (payloadWrites === 1) {
          enteredFirst();
          await firstBlocked;
        }
      }
      return { bytesWritten: length };
    },
    close: async () => {},
  };
  const publisher = new CameraRegionPublisher({
    ...SMALL,
    regionPath: 'ignored',
    ensureDirectory: async () => {},
    openFile: async () => handle,
  });
  await publisher.start();

  const first = publisher.publish(Buffer.alloc(geometry.payloadBytes, 1), 1n);
  await firstEntered;
  const second = publisher.publish(Buffer.alloc(geometry.payloadBytes, 2), 2n);
  const third = publisher.publish(Buffer.alloc(geometry.payloadBytes, 3), 3n);
  releaseFirst();
  await Promise.all([first, second, third]);

  assert.deepEqual(payloadValues, [1, 3]);
  assert.deepEqual(publisher.metrics(), { publishedFrames: 2, droppedFrames: 1 });
});

test('can mark an open publisher idle without closing the region', async () => {
  const writes = [];
  const handle = {
    truncate: async () => {},
    write: async (buffer, offset, length, position) => {
      writes.push({ position, bytes: Buffer.from(buffer.subarray(offset, offset + length)) });
      return { bytesWritten: length };
    },
    close: async () => {},
  };
  const publisher = new CameraRegionPublisher({
    ...SMALL,
    regionPath: 'ignored',
    ensureDirectory: async () => {},
    openFile: async () => handle,
  });
  await publisher.start();
  await publisher.setIdle();
  const stateWrite = writes.at(-1);
  assert.equal(stateWrite.position, OFFSET.writerState);
  assert.equal(stateWrite.bytes.readUInt32LE(0), WRITER_STATE.idle);
});

test('an initialization failure closes and clears the poisoned handle before retry', async () => {
  let attempts = 0;
  let closes = 0;
  const publisher = new CameraRegionPublisher({
    ...SMALL,
    regionPath: 'ignored',
    ensureDirectory: async () => {},
    openFile: async () => {
      attempts += 1;
      return {
        truncate: async () => {
          if (attempts === 1) throw new Error('disk full');
        },
        write: async (_buffer, _offset, length) => ({ bytesWritten: length }),
        close: async () => { closes += 1; },
      };
    },
  });

  await assert.rejects(publisher.start(), /disk full/);
  assert.equal(publisher.handle, null);
  assert.equal(closes, 1);
  await publisher.start();
  assert.equal(attempts, 2);
  await publisher.stop();
});
