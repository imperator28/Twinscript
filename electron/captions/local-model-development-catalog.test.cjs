const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { developmentLocalModelCatalog } = require('./local-model-development-catalog');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'development-local-models-'));
}

test('builds a local-only catalog for the fixed Whisper and HY-MT2 CPU artifacts', () => {
  const appPath = temporaryDirectory();
  const modelRoot = path.join(appPath, 'native', 'local-inference-host', 'models');
  fs.mkdirSync(modelRoot, { recursive: true });
  fs.mkdirSync(path.join(appPath, 'artifacts', 'local-inference'), { recursive: true });
  fs.writeFileSync(path.join(modelRoot, 'export-results.json'), JSON.stringify({
    models: {
      'whisper-small': {
        resolvedRevision: '973afd24965f72e36ca33b3055d56a652f456b4d',
        files: [{ path: 'openvino_encoder_model.xml', size: 12, sha256: 'a'.repeat(64) }],
      },
    },
  }));
  fs.writeFileSync(path.join(appPath, 'artifacts', 'local-inference', 'hymt2-cpu.json'), JSON.stringify({
    resolvedRevision: '1cd5208700acedef4ef93019b6cfc148b8522d45',
    modelFile: 'Hy-MT2-1.8B-Q4_K_M.gguf',
    modelBytes: 24,
    modelSha256: 'b'.repeat(64),
  }));

  const catalog = developmentLocalModelCatalog({ appPath });

  assert.equal(catalog.available, true);
  assert.equal(catalog.localAdoptionAvailable, true);
  assert.equal(catalog.root, modelRoot);
  assert.deepEqual(catalog.manifest.models.map((model) => [model.id, model.expectedDevice, model.localOnly]), [
    ['whisper-small', 'NPU', true],
    ['hy-mt2-1.8b', 'CPU', true],
  ]);
  assert.equal(catalog.manifest.models[1].launchPath, 'Hy-MT2-1.8B-Q4_K_M.gguf');
  fs.rmSync(appPath, { recursive: true, force: true });
});

test('returns unavailable when the verified development artifacts are absent', () => {
  const appPath = temporaryDirectory();

  const catalog = developmentLocalModelCatalog({ appPath });

  assert.equal(catalog.available, false);
  assert.equal(catalog.localAdoptionAvailable, false);
  fs.rmSync(appPath, { recursive: true, force: true });
});
