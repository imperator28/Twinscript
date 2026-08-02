const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../../native/camera-companion/src/host/main.cpp'),
  'utf8',
);
const electronMain = fs.readFileSync(
  path.join(__dirname, '../captions-main.js'),
  'utf8',
);

test('companion serve mode owns camera lifetime and health-only named-pipe control', () => {
  assert.match(source, /int ServeVirtualCamera\(/);
  assert.match(source, /CreateFileW\([^;]*pipe_name\.c_str\(\)/s);
  assert.match(source, /WriteHealth\(pipe, "ready"\)/);
  assert.match(source, /WriteHealth\(pipe, "streaming"\)/);
  assert.match(source, /find\("\\\"command\\\":\\\"stop\\\""\)/);
  assert.match(source, /command == "serve"/);
  assert.match(source, /--region/);
  assert.match(source, /BILINGUAL_VCAM_REGION_PATH/);
});

test('machine registration has a side-effect-free status probe', () => {
  assert.match(source, /int MachineRegistrationStatus\(/);
  assert.match(source, /command == "status-machine"/);
  assert.match(source, /RegOpenKeyExW\(HKEY_LOCAL_MACHINE/);
});

test('application quit is blocked until camera and session shutdown finish', () => {
  assert.match(electronMain, /app\.on\('before-quit', \(event\) =>/);
  assert.match(electronMain, /event\.preventDefault\(\)/);
  assert.match(electronMain, /await captionWindows\?\.stopCameraOutput\(\)/);
  assert.match(electronMain, /shutdownComplete = true;[\s\S]*app\.quit\(\)/);
});
