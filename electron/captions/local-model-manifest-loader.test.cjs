const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { canonicalJson } = require('./local-model-manifest');
const { loadLocalModelCatalog } = require('./local-model-manifest-loader');

function validManifest() {
  return {
    schemaVersion: 1,
    runtimeVersion: '2026.2.1',
    models: [
      {
        id: 'whisper-small', version: '973afd2', displayName: 'Whisper Small',
        purpose: 'Speech recognition', license: 'MIT', source: 'openai/whisper-small',
        expectedDevice: 'NPU', unpackedSize: 12, launchPath: 'model.bin',
        files: [{ path: 'model.bin', url: 'https://models.example.invalid/whisper-small/model.bin', size: 12, sha256: 'a'.repeat(64) }],
      },
      {
        id: 'hy-mt2-1.8b', version: '1.8b', displayName: 'HY-MT2 1.8B',
        purpose: 'Translation', license: 'Apache-2.0', source: 'Tencent-Hunyuan/HY-MT2-1.8B',
        expectedDevice: 'GPU', unpackedSize: 24, launchPath: '.',
        files: [{ path: 'runtime/model.bin', url: 'https://models.example.invalid/hy-mt2-1.8b/runtime/model.bin', size: 24, sha256: 'b'.repeat(64) }],
      },
    ],
  };
}

function writeCatalog(root, { sign = true } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const manifest = validManifest();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(root, 'model-manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'model-manifest-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  if (sign) fs.writeFileSync(path.join(root, 'model-manifest.sig'), crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64'));
  return manifest;
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-model-catalog-'));
}

test('loads a valid signed catalog from packaged resources', () => {
  const resourcesPath = temporaryDirectory();
  const root = path.join(resourcesPath, 'resources', 'local-models');
  const manifest = writeCatalog(root);

  const result = loadLocalModelCatalog({ isPackaged: true, resourcesPath, appPath: 'ignored' });

  assert.deepEqual(result, { available: true, root, manifest, error: null });
});

test('fails closed when a packaged catalog signature is modified or missing', () => {
  for (const mutation of ['modified', 'missing']) {
    const resourcesPath = temporaryDirectory();
    const root = path.join(resourcesPath, 'resources', 'local-models');
    writeCatalog(root);
    const signaturePath = path.join(root, 'model-manifest.sig');
    if (mutation === 'modified') fs.writeFileSync(signaturePath, 'not-a-valid-signature');
    else fs.rmSync(signaturePath);

    const result = loadLocalModelCatalog({ isPackaged: true, resourcesPath, appPath: 'ignored' });
    assert.equal(result.available, false);
    assert.equal(result.root, root);
    assert.equal(result.manifest, null);
    assert.equal(result.error.message, 'Local model downloads are unavailable in this build.');
  }
});

test('loads an unsigned development fixture from the application path', () => {
  const appPath = temporaryDirectory();
  const root = path.join(appPath, 'resources', 'local-models');
  const manifest = writeCatalog(root, { sign: false });

  const result = loadLocalModelCatalog({ isPackaged: false, resourcesPath: 'ignored', appPath });

  assert.deepEqual(result, { available: true, root, manifest, error: null });
});
