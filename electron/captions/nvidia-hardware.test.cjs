const test = require('node:test');
const assert = require('node:assert/strict');
const { detectNvidiaHardware } = require('./nvidia-hardware');
test('hardware offer is Windows-only and requires successful NVIDIA discovery', async () => {
  assert.equal(await detectNvidiaHardware({ platform: 'darwin' }), false);
  assert.equal(await detectNvidiaHardware({ platform: 'win32', execFile: (_cmd, _args, opts, callback) => {
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.timeout, 5000);
    callback(null, 'NVIDIA GeForce RTX 4060\n');
  } }), true);
  assert.equal(await detectNvidiaHardware({ platform: 'win32', execFile: (_c, _a, _o, cb) => cb(new Error('missing')) }), false);
});
