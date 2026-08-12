import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import catalogModule from '../electron/captions/local-model-development-catalog.js';

const { developmentLocalModelCatalog } = catalogModule;

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function sourceFile(sourceRoot, model, file) {
  const base = model.id === 'whisper-small'
    ? path.join(sourceRoot, 'whisper-small')
    : path.join(sourceRoot, 'source-snapshots', 'hy-mt2-1.8b-gguf');
  return path.join(base, ...file.path.split('/'));
}

export async function stageDevelopmentModels({ sourceRoot, targetRoot, manifest }) {
  for (const model of manifest.models) {
    for (const file of model.files) {
      const source = sourceFile(sourceRoot, model, file);
      const target = path.join(targetRoot, model.id, model.version, ...file.path.split('/'));
      const sourceStat = await fsp.stat(source);
      if (!sourceStat.isFile() || sourceStat.size !== file.size) {
        throw new Error(`Source size mismatch for ${model.id}/${file.path}`);
      }
      if ((await sha256(source)).toLowerCase() !== file.sha256.toLowerCase()) {
        throw new Error(`Source hash mismatch for ${model.id}/${file.path}`);
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(source, target);
    }
  }
}

async function main() {
  const appPath = process.cwd();
  const catalog = developmentLocalModelCatalog({ appPath });
  if (!catalog.available || !catalog.manifest) {
    throw new Error('Development Whisper and HY-MT2 artifacts are unavailable.');
  }
  await stageDevelopmentModels({
    sourceRoot: catalog.root,
    targetRoot: catalog.root,
    manifest: catalog.manifest,
  });
  console.log('Staged fixed development Whisper and HY-MT2 artifacts. Open Twinscript and choose Use local files for each model.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
