const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepare } = require('./prepare-local-model-release.cjs');
const { WHISPER_SMALL_REQUIRED_PATHS } = require('../electron/captions/local-model-development-catalog');
const { loadManifest } = require('../electron/captions/local-model-manifest');

test('prepares verified release files and an authenticated downloadable catalog', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-release-'));
  try {
    const models = path.join(root, 'models');
    for (const [id, version, names] of [
      ['whisper-small', 'openvino-int8-973afd24965f72e3', WHISPER_SMALL_REQUIRED_PATHS],
      ['hy-mt2-1.8b', 'q4-k-m-1cd5208700acedef', ['Hy-MT2-1.8B-Q4_K_M.gguf']],
    ]) {
      const dir = path.join(models, id, version);
      fs.mkdirSync(dir, { recursive: true });
      const files = {};
      for (const name of names) {
        fs.writeFileSync(path.join(dir, name), name);
        files[name] = crypto.createHash('sha256').update(name).digest('hex');
      }
      fs.writeFileSync(path.join(dir, '.verified.json'), JSON.stringify({ version, files }));
    }
    const outputRoot = path.join(root, 'release');
    const result = await prepare({ modelRoot: models, outputRoot, baseUrl: 'https://example.com/releases/v1/' });
    assert.equal(result.files, 20);
    const catalog = path.join(outputRoot, 'catalog');
    const manifest = loadManifest({ packaged: true,
      json: fs.readFileSync(path.join(catalog, 'model-manifest.json'), 'utf8'),
      signature: fs.readFileSync(path.join(catalog, 'model-manifest.sig'), 'utf8'),
      publicKey: fs.readFileSync(path.join(catalog, 'model-manifest-public.pem'), 'utf8'),
    });
    assert.ok(manifest.models.every(m => !m.localOnly));
    assert.equal(fs.readdirSync(catalog).length, 3);
    assert.equal(fs.readdirSync(path.join(outputRoot, 'assets')).length, 20);
    const runtimeRoot = path.join(root, 'runtimes');
    fs.mkdirSync(runtimeRoot);
    const archive = Buffer.from('verified runtime archive');
    const runtime = { id: 'openvino-cpu', family: 'cpu', revision: 'b9940', fileName: 'twinscript-runtime-openvino-cpu-b9940.zip', size: archive.length, unpackedSize: 100, sha256: crypto.createHash('sha256').update(archive).digest('hex') };
    fs.writeFileSync(path.join(runtimeRoot, runtime.fileName), archive);
    fs.writeFileSync(path.join(runtimeRoot, 'runtime-archives.json'), JSON.stringify({ runtimes: [runtime] }));
    const withRuntime = path.join(root, 'with-runtime');
    const runtimeResult = await prepare({ modelRoot: models, outputRoot: withRuntime, baseUrl: 'https://example.com/releases/v1/', runtimeRoot });
    assert.equal(runtimeResult.runtimes, 1);
    const runtimeManifest = loadManifest({ packaged: true,
      json: fs.readFileSync(path.join(withRuntime, 'catalog/model-manifest.json'), 'utf8'),
      signature: fs.readFileSync(path.join(withRuntime, 'catalog/model-manifest.sig'), 'utf8'),
      publicKey: fs.readFileSync(path.join(withRuntime, 'catalog/model-manifest-public.pem'), 'utf8'),
    });
    assert.equal(runtimeManifest.runtimes[0].url, `https://example.com/releases/v1/${runtime.fileName}`);
    assert.deepEqual(fs.readFileSync(path.join(withRuntime, 'assets', runtime.fileName)), archive);
    fs.appendFileSync(path.join(runtimeRoot, runtime.fileName), 'corrupt');
    await assert.rejects(prepare({ modelRoot: models, outputRoot: path.join(root, 'bad-runtime'), baseUrl: 'https://example.com/', runtimeRoot }), /runtime.*verification/i);
    assert.equal(fs.existsSync(path.join(root, 'bad-runtime')), false);
    fs.appendFileSync(path.join(models, 'whisper-small', 'openvino-int8-973afd24965f72e3', 'config.json'), 'corrupt');
    await assert.rejects(prepare({ modelRoot: models, outputRoot: path.join(root, 'bad'), baseUrl: 'https://example.com/' }), /failed verification/);
    assert.equal(fs.existsSync(path.join(root, 'bad')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
