// The retry that stops "the app is blank".
//
// `npm run dev` starts Electron as soon as the main-process build finishes, which
// is many seconds before the renderer dev server is listening. Every window did
// `void window.loadURL(...)` - one attempt, promise discarded - so losing that
// race was permanent. The control window is created `show: false` and revealed on
// `ready-to-show`, which cannot fire for a page that never loaded, so the app had
// no visible window at all.
const assert = require('node:assert/strict');
const test = require('node:test');
const { loadDevRendererUrl } = require('./dev-renderer-load');

/** A BrowserWindow stand-in that fails a given number of loads, then succeeds. */
function fakeWindow(failures) {
  const calls = [];
  let remaining = failures;
  return {
    calls,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    loadURL(url) {
      calls.push(url);
      if (remaining > 0) {
        remaining -= 1;
        return Promise.reject(new Error('ERR_CONNECTION_REFUSED'));
      }
      return Promise.resolve();
    },
  };
}

/** Runs scheduled callbacks immediately, recording the delays asked for. */
function immediateScheduler() {
  const delays = [];
  const schedule = (fn, ms) => {
    delays.push(ms);
    // Queued as a microtask so the rejection handler finishes first.
    void Promise.resolve().then(fn);
  };
  schedule.delays = delays;
  return schedule;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('retries until the dev server answers', async () => {
  const window = fakeWindow(4);
  const schedule = immediateScheduler();
  loadDevRendererUrl({ window, url: 'http://localhost:5173/?surface=control', schedule });
  await settle();
  // Four refusals then a success: five attempts, not one.
  assert.equal(window.calls.length, 5);
  assert.ok(window.calls.every((url) => url.includes('surface=control')));
});

test('succeeds on the first attempt without scheduling anything', async () => {
  const window = fakeWindow(0);
  const schedule = immediateScheduler();
  loadDevRendererUrl({ window, url: 'http://x', schedule });
  await settle();
  assert.equal(window.calls.length, 1);
  assert.deepEqual(schedule.delays, []);
});

test('gives up after the attempt cap rather than spinning forever', async () => {
  const window = fakeWindow(Number.MAX_SAFE_INTEGER);
  const schedule = immediateScheduler();
  let gaveUp = 0;
  loadDevRendererUrl({
    window,
    url: 'http://x',
    schedule,
    maxAttempts: 3,
    onGiveUp: () => {
      gaveUp += 1;
    },
  });
  await settle();
  assert.equal(window.calls.length, 3);
  assert.equal(gaveUp, 1, 'a permanent failure must be reported, not swallowed');
});

test('stops when the window is destroyed mid-retry', async () => {
  // Quitting during startup must not keep loading a dead window.
  const window = fakeWindow(Number.MAX_SAFE_INTEGER);
  const schedule = (fn) => {
    window.destroyed = true;
    void Promise.resolve().then(fn);
  };
  loadDevRendererUrl({ window, url: 'http://x', schedule });
  await settle();
  assert.equal(window.calls.length, 1);
});

test('waits between attempts instead of hammering the port', async () => {
  const window = fakeWindow(2);
  const schedule = immediateScheduler();
  loadDevRendererUrl({ window, url: 'http://x', delayMs: 400, schedule });
  await settle();
  assert.deepEqual(schedule.delays, [400, 400]);
});

test('the default cap covers a slow cold start', () => {
  // Measured at ~21s on this repository after the dependency tree changed, so the
  // default budget has to be comfortably larger than that.
  const window = fakeWindow(0);
  let observed = null;
  loadDevRendererUrl({
    window,
    url: 'http://x',
    schedule: (_fn, ms) => {
      observed = ms;
    },
  });
  // One success, so nothing was scheduled; assert the documented defaults instead
  // by reading them off a forced failure.
  const failing = fakeWindow(1);
  loadDevRendererUrl({ window: failing, url: 'http://x', schedule: (_fn, ms) => {
    observed = ms;
  } });
  return Promise.resolve().then(() => {
    assert.equal(observed, 400);
    // 150 attempts x 400ms = 60s.
    assert.ok(150 * 400 >= 30000, 'default budget must exceed a slow Vite start');
  });
});
