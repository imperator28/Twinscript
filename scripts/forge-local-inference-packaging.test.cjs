const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const { canonicalJson } = require('../electron/captions/local-model-manifest');

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
    // Supply the catalog that extraResource would copy. This test must work on
    // a clean checkout without developer model exports or installed models.
    const catalogRoot = path.join(packageRoot, 'resources', 'resources', 'local-models');
    fs.mkdirSync(catalogRoot, { recursive: true });
    const manifest = { schemaVersion: 1, runtimeVersion: 'test-v1', models:
      ['whisper-small', 'hy-mt2-1.8b'].map((id) => ({
        id, version: 'test-v1', displayName: id, purpose: 'Test fixture',
        license: 'MIT', source: 'Test fixture', expectedDevice: 'CPU',
        unpackedSize: 1, launchPath: 'model.bin',
        files: [{ path: 'model.bin', size: 1, sha256: 'a'.repeat(64), url: 'https://example.invalid/model.bin' }],
      })) };
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(catalogRoot, 'model-manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(catalogRoot, 'model-manifest.sig'), crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64'));
    fs.writeFileSync(path.join(catalogRoot, 'model-manifest-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
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
