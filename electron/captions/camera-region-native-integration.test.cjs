const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { CameraRegionPublisher } = require('./camera-region-publisher');
const { computeGeometry } = require('./camera-frame-transport');

test(
  'the native mapped reader consumes one full-size frame published by Node',
  { skip: process.platform !== 'win32' },
  async () => {
    const executable = path.resolve(
      __dirname,
      '../../native/camera-companion/build/Release/mapped-frame-reader-check.exe',
    );
    if (!fs.existsSync(executable)) return;

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-vcam-region-'));
    const regionPath = path.join(directory, 'camera-frame-v1.bin');
    const publisher = new CameraRegionPublisher({ regionPath });
    try {
      await publisher.start();
      await publisher.publish(
        Buffer.alloc(computeGeometry().payloadBytes, 0x5a),
        process.hrtime.bigint(),
      );
      const result = spawnSync(
        executable,
        ['--region', regionPath, '--expect-byte', '90'],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /external full-size frame.*8294400 bytes/i);
    } finally {
      await publisher.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

