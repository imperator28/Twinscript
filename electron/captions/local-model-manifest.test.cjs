const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { ALLOWED_MODEL_IDS, canonicalJson, loadManifest, validateManifest } = require('./local-model-manifest');

function exampleManifest() {
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

test('catalog allows exactly the two declared model IDs', () => {
  assert.deepEqual(ALLOWED_MODEL_IDS, ['whisper-small', 'hy-mt2-1.8b']);
  assert.equal(validateManifest(exampleManifest()).models.length, 2);

  for (const mutate of [
    (manifest) => { manifest.models[1].id = 'unknown'; },
    (manifest) => { manifest.models[1].id = 'whisper-small'; },
    (manifest) => { manifest.models.pop(); },
  ]) {
    const manifest = exampleManifest();
    mutate(manifest);
    assert.throws(() => validateManifest(manifest), { code: 'local_manifest_invalid' });
  }
});

test('catalog requires model launch details and safe declared metadata', () => {
  for (const mutate of [
    (model) => { delete model.displayName; },
    (model) => { delete model.purpose; },
    (model) => { delete model.license; },
    (model) => { delete model.source; },
    (model) => { model.expectedDevice = 'TPU'; },
    (model) => { model.unpackedSize = -1; },
    (model) => { model.unpackedSize = Number.MAX_SAFE_INTEGER + 1; },
    (model) => { delete model.launchPath; },
    (model) => { model.launchPath = 'missing.bin'; },
    (model) => { model.launchPath = 'runtime/../model.bin'; },
  ]) {
    const manifest = exampleManifest();
    mutate(manifest.models[0]);
    assert.throws(() => validateManifest(manifest), { code: 'local_manifest_invalid' });
  }
});

test('catalog requires canonical bounded runtime and model version segments', () => {
  for (const mutate of [
    (manifest) => { manifest.runtimeVersion = ''; },
    (manifest) => { manifest.runtimeVersion = '..'; },
    (manifest) => { manifest.runtimeVersion = '2026/2.1'; },
    (manifest) => { manifest.runtimeVersion = 'a'.repeat(129); },
    (manifest) => { manifest.runtimeVersion = 2026; },
    (manifest) => { manifest.models[0].version = '..'; },
    (manifest) => { manifest.models[0].version = 'release/1'; },
    (manifest) => { manifest.models[0].version = 'CON'; },
    (manifest) => { manifest.models[0].version = 'LPT9.bin'; },
    (manifest) => { manifest.models[0].version = 'release '; },
    (manifest) => { manifest.models[0].version = 'a'.repeat(129); },
    (manifest) => { manifest.models[0].version = 1; },
  ]) {
    const manifest = exampleManifest();
    mutate(manifest);
    assert.throws(() => validateManifest(manifest), { code: 'local_manifest_invalid' });
  }
});

test('catalog requires parseable HTTPS file URLs with hostnames', () => {
  for (const url of ['https://', 'not a URL', 'http://models.example.invalid/file.bin']) {
    const manifest = exampleManifest();
    manifest.models[0].files[0].url = url;
    assert.throws(() => validateManifest(manifest), { code: 'local_manifest_invalid' });
  }
});

test('packaged manifests require a valid Ed25519 signature', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => loadManifest({
    json: exampleManifest(), signature: Buffer.alloc(64).toString('base64'), publicKey, packaged: true,
  }), { code: 'local_manifest_invalid' });
});

test('a valid packaged signature and development unsigned manifest are accepted', () => {
  const manifest = exampleManifest();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString('base64');

  assert.equal(loadManifest({ json: manifest, signature, publicKey, packaged: true }).models[0].id, 'whisper-small');
  assert.equal(loadManifest({ json: manifest, packaged: false }).runtimeVersion, '2026.2.1');
});

test('canonical JSON is stable across key order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test('manifest rejects paths that normalize outside or alias another file', () => {
  const unsafe = exampleManifest();
  unsafe.models[0].files = [
    { path: 'models/../runtime.dll', url: 'https://models.example.invalid/a', size: 1, sha256: 'a'.repeat(64) },
    { path: 'runtime.dll', url: 'https://models.example.invalid/b', size: 1, sha256: 'b'.repeat(64) },
  ];

  assert.throws(() => loadManifest({ json: unsafe, packaged: false }), { code: 'local_manifest_invalid' });
});
