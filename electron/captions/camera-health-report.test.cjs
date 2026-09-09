// Camera health reports must stay complete.
//
// The control panel REPLACES its health report with whatever arrives rather
// than merging, so a partial report is not a partial update there - it is a
// report where every field nobody sent has become undefined. A camera start or
// stop failure used to broadcast `{ state, message }` straight to the window,
// which dropped `supported`, and the panel read a missing `supported` as a
// platform that cannot host a virtual camera at all. A Windows machine with the
// filter correctly registered was told to go and use OBS, and the actual error
// never reached the screen.
const assert = require('node:assert/strict');
const test = require('node:test');
const { CaptionWindowManager } = require('./caption-window-manager');
const { NativeCameraSupervisor } = require('./native-camera-supervisor');

/** A supervisor on a machine that can host the camera, with no registry access. */
function supervisor(onHealth = () => {}) {
  return new NativeCameraSupervisor({
    platform: 'win32',
    release: '10.0.26200',
    arch: 'x64',
    onHealth,
    inspectDshowCamera: () => ({
      installed: true,
      filterPath: 'C:\\ProgramData\\Twinscript\\bin\\filter.dll',
      reason: null,
    }),
  });
}

const report = CaptionWindowManager.prototype.reportCameraOutputFailure;

test('a camera output failure keeps the fields it did not set', async () => {
  const reports = [];
  const camera = supervisor(health => reports.push(health));
  await camera.refresh();
  assert.equal(camera.snapshot().supported, true);
  assert.equal(camera.snapshot().installed, true);

  const broadcasts = [];
  report.call(
    { nativeCameraSupervisor: camera, broadcastControl: (...args) => broadcasts.push(args) },
    new Error('Camera companion exited with code 1'),
  );

  const health = reports.at(-1);
  assert.equal(health.state, 'failed');
  assert.equal(health.message, 'Camera companion exited with code 1');
  // The point of the whole exercise: a failure to START the camera is not a
  // platform that cannot host one, and must not be reported as though it were.
  assert.equal(health.supported, true);
  assert.equal(health.installed, true);
  // Published through the supervisor's own channel, so there is one path and one
  // shape rather than a second hand-rolled broadcast that can drift.
  assert.deepEqual(broadcasts, []);
});

test('the real error survives, because it is what the operator can act on', async () => {
  const reports = [];
  const camera = supervisor(health => reports.push(health));
  await camera.refresh();
  report.call({ nativeCameraSupervisor: camera, broadcastControl: () => {} }, new Error('pipe busy'));
  assert.match(reports.at(-1).message, /pipe busy/);
});

test('with no supervisor the fallback report is still complete', () => {
  // Reached where the platform has no camera to host. `supported: false` is then
  // the truth, and it is stated rather than left undefined for the panel to
  // guess at.
  const broadcasts = [];
  report.call(
    { nativeCameraSupervisor: null, broadcastControl: (...args) => broadcasts.push(args) },
    new Error('no camera here'),
  );
  assert.equal(broadcasts.length, 1);
  const [channel, health] = broadcasts[0];
  assert.equal(channel, 'captions:native-camera-health');
  for (const field of ['state', 'supported', 'installed', 'reason', 'restartCount', 'message', 'code']) {
    assert.ok(field in health, `fallback report is missing ${field}`);
  }
  assert.equal(health.supported, false);
  assert.equal(health.message, 'no camera here');
});

test('a non-Error rejection still produces a readable message', () => {
  const broadcasts = [];
  report.call(
    { nativeCameraSupervisor: null, broadcastControl: (...args) => broadcasts.push(args) },
    'spawn ENOENT',
  );
  assert.equal(broadcasts[0][1].message, 'spawn ENOENT');
});
