const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadManifest } = require('../electron/captions/local-model-manifest');
const { WHISPER_SMALL_REQUIRED_PATHS } = require('../electron/captions/local-model-development-catalog');
const { stageBetaLocalModelCatalog } = require('./beta-local-model-catalog.cjs');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('stages a signed packaged catalog from pinned beta artifact metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-beta-catalog-'));
  const appPath = path.join(root, 'app');
  const packageRoot = path.join(root, 'package');
  const whisperRoot = path.join(appPath, 'native', 'local-inference-host', 'models');
  const translationRoot = path.join(appPath, 'artifacts', 'local-inference');
  fs.mkdirSync(whisperRoot, { recursive: true });
  fs.mkdirSync(translationRoot, { recursive: true });
  fs.writeFileSync(path.join(whisperRoot, 'export-results.json'), JSON.stringify({
    models: {
      'whisper-small': {
        resolvedRevision: '973afd24965f72e36ca33b3055d56a652f456b4d',
        exported: true,
        files: WHISPER_SMALL_REQUIRED_PATHS.map((filePath) => ({
          path: filePath,
          size: 3,
          sha256: sha(filePath),
        })),
      },
    },
  }));
  fs.writeFileSync(path.join(translationRoot, 'hymt2-cpu.json'), JSON.stringify({
    resolvedRevision: '1cd5208700acedef4ef93019b6cfc148b8522d45',
    passed: true,
    modelFile: 'Hy-MT2-1.8B-Q4_K_M.gguf',
    modelBytes: 4,
    modelSha256: sha('gguf'),
  }));

  try {
    const catalogRoot = stageBetaLocalModelCatalog({ appPath, packageRoot });
    assert.equal(catalogRoot, path.join(packageRoot, 'resources', 'resources', 'local-models'));
    const json = fs.readFileSync(path.join(catalogRoot, 'model-manifest.json'), 'utf8');
    const signature = fs.readFileSync(path.join(catalogRoot, 'model-manifest.sig'), 'utf8');
    const publicKey = fs.readFileSync(path.join(catalogRoot, 'model-manifest-public.pem'), 'utf8');
    const manifest = loadManifest({ json, signature, publicKey, packaged: true });

    assert.deepEqual(manifest.models.map(({ id, version }) => ({ id, version })), [
      { id: 'whisper-small', version: 'openvino-int8-973afd24965f72e3' },
      { id: 'hy-mt2-1.8b', version: 'q4-k-m-1cd5208700acedef' },
    ]);
    assert.equal(manifest.models.every((model) => model.localOnly), true);
    assert.equal(fs.existsSync(path.join(catalogRoot, 'model-manifest-private.pem')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to package private signing material from the resources tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-private-catalog-'));
  const catalogRoot = path.join(root, 'package', 'resources', 'resources', 'local-models');
  fs.mkdirSync(catalogRoot, { recursive: true });
  fs.writeFileSync(path.join(catalogRoot, 'model-manifest-private.pem'), 'PRIVATE KEY');
  try {
    assert.throws(
      () => stageBetaLocalModelCatalog({ appPath: path.join(root, 'app'), packageRoot: path.join(root, 'package') }),
      /private signing material/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to sign failed or unpinned beta artifact metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twinscript-failed-catalog-'));
  const appPath = path.join(root, 'app');
  const whisperRoot = path.join(appPath, 'native', 'local-inference-host', 'models');
  const translationRoot = path.join(appPath, 'artifacts', 'local-inference');
  fs.mkdirSync(whisperRoot, { recursive: true });
  fs.mkdirSync(translationRoot, { recursive: true });
  fs.writeFileSync(path.join(whisperRoot, 'export-results.json'), JSON.stringify({
    models: {
      'whisper-small': {
        resolvedRevision: '973afd24965f72e36ca33b3055d56a652f456b4d',
        exported: true,
        files: [{ path: 'partial.xml', size: 3, sha256: sha('xml') }],
      },
    },
  }));
  fs.writeFileSync(path.join(translationRoot, 'hymt2-cpu.json'), JSON.stringify({
    resolvedRevision: '1cd5208700acedef4ef93019b6cfc148b8522d45',
    passed: true,
    modelFile: 'Hy-MT2-1.8B-Q4_K_M.gguf',
    modelBytes: 4,
    modelSha256: sha('gguf'),
  }));
  try {
    assert.throws(
      () => stageBetaLocalModelCatalog({ appPath, packageRoot: path.join(root, 'package') }),
      /pinned beta model metadata/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
