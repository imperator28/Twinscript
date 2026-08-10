const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function modelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

class LocalModelManager {
  constructor({
    manifest,
    root,
    sessionActive = () => false,
    fetchImpl = globalThis.fetch,
    onProgress = () => {},
  }) {
    this.manifest = manifest;
    this.root = root;
    this.sessionActive = sessionActive;
    this.fetchImpl = fetchImpl;
    this.onProgress = onProgress;
    this.inFlight = new Set();
  }

  model(modelId) {
    const model = this.manifest.models.find((candidate) => candidate.id === modelId);
    if (!model) throw modelError('local_model_unknown', `Unknown local model: ${modelId}`);
    return model;
  }

  modelDirectory(model) {
    return path.join(this.root, model.id, model.version);
  }

  status() {
    const models = {};
    for (const model of this.manifest.models) {
      const directory = this.modelDirectory(model);
      const markerPath = path.join(directory, '.verified.json');
      let ready = false;
      try {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        ready = marker.version === model.version && model.files.every((file) => {
          const filePath = path.join(directory, ...file.path.split('/'));
          return fs.statSync(filePath).size === file.size && marker.files[file.path] === file.sha256;
        });
      } catch {
        ready = false;
      }
      models[model.id] = {
        version: model.version,
        ready,
        downloading: this.inFlight.has(model.id),
        bytes: model.files.reduce((sum, file) => sum + file.size, 0),
      };
    }
    return { runtimeVersion: this.manifest.runtimeVersion, models };
  }

  async download(modelId) {
    if (this.sessionActive()) {
      throw modelError('meeting_active', 'Local models cannot change during a meeting');
    }
    if (this.inFlight.has(modelId)) {
      throw modelError('local_model_download_active', 'This model is already downloading');
    }
    const model = this.model(modelId);
    const directory = this.modelDirectory(model);
    this.inFlight.add(modelId);
    let completedBytes = 0;
    const totalBytes = model.files.reduce((sum, file) => sum + file.size, 0);
    try {
      for (const file of model.files) {
        const destination = path.join(directory, ...file.path.split('/'));
        const partial = `${destination}.partial`;
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        let offset = 0;
        try {
          offset = (await fsp.stat(partial)).size;
          if (offset > file.size) {
            await fsp.rm(partial, { force: true });
            offset = 0;
          }
        } catch {
          offset = 0;
        }
        const response = await this.fetchImpl(file.url, {
          headers: offset ? { Range: `bytes=${offset}-` } : {},
        });
        if (!response.ok) {
          throw modelError('local_model_download_failed', `Download failed with HTTP ${response.status}`);
        }
        const resumed = offset > 0 && response.status === 206;
        if (!resumed) offset = 0;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (resumed) await fsp.appendFile(partial, bytes);
        else await fsp.writeFile(partial, bytes, { mode: 0o600 });
        const stat = await fsp.stat(partial);
        if (stat.size !== file.size) {
          throw modelError('local_model_size_mismatch', `Size mismatch for ${file.path}`);
        }
        const digest = await sha256(partial);
        if (digest !== file.sha256) {
          await fsp.rm(partial, { force: true });
          throw modelError('local_model_hash_mismatch', `Hash mismatch for ${file.path}`);
        }
        await fsp.rename(partial, destination);
        completedBytes += file.size;
        this.onProgress({ modelId, completedBytes, totalBytes });
      }
      const marker = {
        version: model.version,
        files: Object.fromEntries(model.files.map((file) => [file.path, file.sha256])),
      };
      const markerPath = path.join(directory, '.verified.json');
      const temporary = `${markerPath}.tmp`;
      await fsp.writeFile(temporary, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(temporary, markerPath);
      return this.status().models[modelId];
    } finally {
      this.inFlight.delete(modelId);
    }
  }

  async remove(modelId) {
    if (this.sessionActive()) {
      throw modelError('meeting_active', 'Local models cannot change during a meeting');
    }
    const model = this.model(modelId);
    await fsp.rm(this.modelDirectory(model), { recursive: true, force: true });
    return this.status().models[modelId];
  }
}

module.exports = { LocalModelManager, sha256 };
