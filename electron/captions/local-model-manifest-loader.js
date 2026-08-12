const fs = require('fs');
const path = require('path');
const { loadManifest } = require('./local-model-manifest');
const { developmentLocalModelCatalog } = require('./local-model-development-catalog');

const CATALOG_ERROR_MESSAGE = 'Local model downloads are unavailable in this build.';

function loadLocalModelCatalog({ isPackaged, resourcesPath, appPath, fsImpl = fs, developmentCatalog = null }) {
  const basePath = isPackaged ? resourcesPath : appPath;
  const root = path.join(basePath, 'resources', 'local-models');
  try {
    const json = fsImpl.readFileSync(path.join(root, 'model-manifest.json'), 'utf8');
    const signature = isPackaged
      ? fsImpl.readFileSync(path.join(root, 'model-manifest.sig'), 'utf8')
      : undefined;
    const publicKey = isPackaged
      ? fsImpl.readFileSync(path.join(root, 'model-manifest-public.pem'), 'utf8')
      : undefined;
    const manifest = loadManifest({ json, signature, publicKey, packaged: Boolean(isPackaged) });
    return { available: true, root, manifest, error: null };
  } catch {
    if (!isPackaged) {
      const createDevelopmentCatalog = developmentCatalog || developmentLocalModelCatalog;
      if (typeof createDevelopmentCatalog === 'function') return createDevelopmentCatalog({ appPath });
    }
    return {
      available: false,
      root,
      manifest: null,
      error: { code: 'local_catalog_unavailable', message: CATALOG_ERROR_MESSAGE },
    };
  }
}

module.exports = { loadLocalModelCatalog };
