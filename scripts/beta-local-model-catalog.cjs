const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { developmentLocalModelCatalog } = require('../electron/captions/local-model-development-catalog');
const { canonicalJson, loadManifest } = require('../electron/captions/local-model-manifest');

const CATALOG_FILES = [
  'model-manifest.json',
  'model-manifest.sig',
  'model-manifest-public.pem',
];
const PACKAGED_CATALOG_ALLOWLIST = new Set([...CATALOG_FILES, 'README.md']);

function readPackagedCatalog(catalogRoot) {
  return loadManifest({
    json: fs.readFileSync(path.join(catalogRoot, CATALOG_FILES[0]), 'utf8'),
    signature: fs.readFileSync(path.join(catalogRoot, CATALOG_FILES[1]), 'utf8'),
    publicKey: fs.readFileSync(path.join(catalogRoot, CATALOG_FILES[2]), 'utf8'),
    packaged: true,
  });
}

function stageBetaLocalModelCatalog({ appPath, packageRoot }) {
  // `resources` is copied as a named extraResource directory. At runtime,
  // process.resourcesPath is the first `resources`, and the catalog loader
  // intentionally reads the app-owned tree beneath it.
  const catalogRoot = path.resolve(packageRoot, 'resources', 'resources', 'local-models');
  if (fs.existsSync(catalogRoot)) {
    const unexpected = fs.readdirSync(catalogRoot, { withFileTypes: true })
      .filter((entry) => !entry.isFile() || !PACKAGED_CATALOG_ALLOWLIST.has(entry.name));
    if (unexpected.length) {
      throw new Error(
        `Local-model resources contain private signing material or unsupported files: ${unexpected.map((entry) => entry.name).join(', ')}`,
      );
    }
  }
  const existing = CATALOG_FILES.filter((name) => fs.existsSync(path.join(catalogRoot, name)));
  if (existing.length === CATALOG_FILES.length) {
    readPackagedCatalog(catalogRoot);
    return catalogRoot;
  }
  if (existing.length > 0) {
    throw new Error('Packaged local-model catalog is incomplete; refusing to replace release metadata.');
  }

  const development = developmentLocalModelCatalog({ appPath });
  if (!development.available || !development.manifest) {
    throw new Error(
      'No signed release catalog or pinned beta model metadata is available. ' +
      'Stage the model artifacts before packaging.',
    );
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const canonical = canonicalJson(development.manifest);
  const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  fs.mkdirSync(catalogRoot, { recursive: true });
  fs.writeFileSync(path.join(catalogRoot, CATALOG_FILES[0]), `${JSON.stringify(development.manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(catalogRoot, CATALOG_FILES[1]), `${signature}\n`);
  fs.writeFileSync(path.join(catalogRoot, CATALOG_FILES[2]), publicPem);
  readPackagedCatalog(catalogRoot);
  return catalogRoot;
}

module.exports = { CATALOG_FILES, stageBetaLocalModelCatalog };
