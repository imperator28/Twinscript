const fs = require('node:fs');
const path = require('node:path');
const { loadManifest } = require('../electron/captions/local-model-manifest');

const files = ['model-manifest.json', 'model-manifest.sig', 'model-manifest-public.pem'];
function assertReleaseCatalog(root) {
  for (const file of files) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing signed release catalog file: ${file}`);
  }
  const allowed = new Set([...files, 'README.md']);
  if (fs.readdirSync(root).some(name => !allowed.has(name))) throw new Error('Unexpected file in release catalog; never package private signing material.');
  return loadManifest({
    json: fs.readFileSync(path.join(root, files[0]), 'utf8'),
    signature: fs.readFileSync(path.join(root, files[1]), 'utf8'),
    publicKey: fs.readFileSync(path.join(root, files[2]), 'utf8'),
    packaged: true,
  });
}
module.exports = { assertReleaseCatalog };
