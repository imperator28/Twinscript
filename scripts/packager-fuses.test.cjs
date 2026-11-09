const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('both packagers use the same security fuses', () => {
  const sources = ['forge.config.js', 'scripts/electron-builder-fuses.js'].map(p => fs.readFileSync(p, 'utf8'));
  for (const source of sources) {
    for (const [name, value] of Object.entries({ RunAsNode: false, EnableCookieEncryption: false,
      EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true })) {
      assert.ok(source.includes(`[FuseV1Options.${name}]: ${value}`), name);
    }
  }
});
