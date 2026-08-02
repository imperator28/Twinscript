const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { computeGeometry } = require('./camera-frame-transport');
const { CameraStageFramePublisher } = require('./camera-stage-frame-publisher');

class FakeWebContents extends EventEmitter {
  setFrameRate(value) { this.frameRate = value; }
  startPainting() { this.painting = true; }
  stopPainting() { this.painting = false; }
}

function image({ width = 1920, height = 1080, byte = 7, empty = false } = {}) {
  const value = {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    toBitmap: () => Buffer.alloc(width * height * 4, byte),
  };
  value.resize = (options) => {
    value.resizeOptions = options;
    value.resized = image({ width: options.width, height: options.height, byte });
    return value.resized;
  };
  return value;
}

test('publishes bounded 1920x1080 offscreen paint frames at 15 fps', async () => {
  const webContents = new FakeWebContents();
  const published = [];
  const regionPublisher = {
    start: async () => { regionPublisher.started = true; },
    publish: async (buffer, capturedAt) => published.push({ buffer, capturedAt }),
    stop: async () => { regionPublisher.stopped = true; },
  };
  const adapter = new CameraStageFramePublisher({ regionPublisher });
  await adapter.start({ webContents });

  assert.equal(webContents.frameRate, 15);
  assert.equal(webContents.painting, true);
  const frame = image();
  webContents.emit('paint', {}, { x: 0, y: 0, width: 1920, height: 1080 }, frame);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(published.length, 1);
  assert.equal(published[0].buffer.length, computeGeometry().payloadBytes);
  assert.equal(typeof published[0].capturedAt, 'bigint');

  await adapter.stop();
  assert.equal(webContents.painting, false);
  assert.equal(regionPublisher.stopped, true);
  assert.equal(webContents.listenerCount('paint'), 0);
});

test('resizes a mismatched compositor image before publication', async () => {
  const webContents = new FakeWebContents();
  let published;
  const regionPublisher = {
    start: async () => {},
    publish: async (buffer) => { published = buffer; },
    stop: async () => {},
  };
  const adapter = new CameraStageFramePublisher({ regionPublisher });
  await adapter.start({ webContents });
  const smaller = image({ width: 960, height: 540 });
  webContents.emit('paint', {}, {}, smaller);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(smaller.resizeOptions, {
    width: 1920,
    height: 1080,
    quality: 'good',
  });
  assert.equal(published.length, computeGeometry().payloadBytes);
});

test('ignores empty compositor images without failing the camera', async () => {
  const webContents = new FakeWebContents();
  let calls = 0;
  const regionPublisher = {
    start: async () => {},
    publish: async () => { calls += 1; },
    stop: async () => {},
  };
  const adapter = new CameraStageFramePublisher({ regionPublisher });
  await adapter.start({ webContents });
  webContents.emit('paint', {}, {}, image({ empty: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});


test('keeps the region current between paints so a static stage is not blank', async () => {
  // Chromium emits `paint` only when the page changes. Without a heartbeat a
  // stage showing unchanged captions stops publishing, the native reader
  // expires the region after two seconds, and the meeting app shows a blank
  // camera — while idle and during any pause between utterances.
  const webContents = new FakeWebContents();
  const touches = [];
  const regionPublisher = {
    start: async () => {},
    publish: async () => {},
    stop: async () => {},
    touch: async (at) => { touches.push(at); return true; },
  };
  let tick = null;
  const adapter = new CameraStageFramePublisher({
    regionPublisher,
    heartbeatMs: 500,
    now: () => 42n,
    setIntervalImpl: (fn) => { tick = fn; return { unref() {} }; },
    clearIntervalImpl: () => { tick = null; },
  });

  await adapter.start({ webContents });
  assert.equal(typeof tick, 'function', 'a heartbeat is armed on start');

  tick();
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(touches, [42n, 42n]);

  await adapter.stop();
  assert.equal(tick, null, 'the heartbeat is cleared on stop');
});

test('a heartbeat failure is reported without tearing down the camera', async () => {
  const webContents = new FakeWebContents();
  const errors = [];
  const regionPublisher = {
    start: async () => {},
    publish: async () => {},
    stop: async () => {},
    touch: async () => { throw new Error('region vanished'); },
  };
  let tick = null;
  const adapter = new CameraStageFramePublisher({
    regionPublisher,
    setIntervalImpl: (fn) => { tick = fn; return { unref() {} }; },
    clearIntervalImpl: () => { tick = null; },
    onError: (error) => errors.push(error.message),
  });

  await adapter.start({ webContents });
  tick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, ['region vanished']);
  await adapter.stop();
});
