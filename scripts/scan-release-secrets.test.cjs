const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('./scan-release-secrets.cjs');
test('unpacked scanner detects keys across read boundaries without revealing matched bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-scan-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.asar'), 'x'.repeat(65530) + 'sk-' + 'A'.repeat(48));
    assert.throws(() => scan(dir), error => error.message.includes('app.asar') && !error.message.includes('AAAA'));
    fs.writeFileSync(path.join(dir, 'app.asar'), 'safe caption client');
    assert.equal(scan(dir), 1);
    fs.writeFileSync(path.join(dir, '.env.local'), 'no secrets needed to reject this file');
    assert.throws(() => scan(dir), /Environment file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
