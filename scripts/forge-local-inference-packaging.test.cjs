const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const forgeConfig = require('../forge.config.js');

test('packaged local inference is validated only after extra resources are copied', async () => {
  assert.ok(Array.isArray(forgeConfig.packagerConfig.afterCopyExtraResources));
  const [hook] = forgeConfig.packagerConfig.afterCopyExtraResources;
  assert.equal(typeof hook, 'function');
  assert.doesNotMatch(
    forgeConfig.hooks.packageAfterCopy.toString(),
    /validatePackagedLocalInference/,
  );

  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-forge-hook-'));
  try {
    const runHook = () => new Promise((resolve, reject) => {
      hook(packageRoot, '40.0.0', 'win32', 'x64', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await assert.rejects(
      runHook(),
      /Invalid packaged local-inference runtime:.*runtime-manifest\.json/,
    );
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});
