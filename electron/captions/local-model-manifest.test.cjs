const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { canonicalJson, loadManifest } = require('./local-model-manifest');


function exampleManifest() {
  return {
    schemaVersion: 1,
    runtimeVersion: '2026.2.1',
    models: [{
      id: 'whisper-small',
      version: '973afd2',
      license: 'MIT',
      source: 'openai/whisper-small',
      unpackedSize: 12,
      files: [{ path: 'model.bin', url: 'https://example.invalid/model.bin', size: 12, sha256: 'a'.repeat(64) }],
    }],
  };
}

test('packaged manifests require a valid Ed25519 signature', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => loadManifest({
    json: exampleManifest(),
    signature: Buffer.alloc(64).toString('base64'),
    publicKey,
    packaged: true,
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
    { path: 'models/../runtime.dll', url: 'https://example.invalid/a', size: 1, sha256: 'a'.repeat(64) },
    { path: 'runtime.dll', url: 'https://example.invalid/b', size: 1, sha256: 'b'.repeat(64) },
  ];

  assert.throws(
    () => loadManifest({ json: unsafe, packaged: false }),
    (error) => error.code === 'local_manifest_invalid',
  );
});
