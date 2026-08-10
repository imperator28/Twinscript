const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

function modelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serializableError(error) {
  return { code: error?.code || 'local_model_failed', message: error?.message || 'Local model operation failed' };
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
  constructor({ manifest, root, sessionActive = () => false, fetchImpl = globalThis.fetch, onProgress = () => {} }) {
    this.manifest = manifest;
    this.root = root;
    this.sessionActive = sessionActive;
    this.fetchImpl = fetchImpl;
    this.onProgress = onProgress;
    this.operations = new Map();
    this.failures = new Map();
  }

  model(modelId) {
    const model = this.manifest.models.find((candidate) => candidate.id === modelId);
    if (!model) throw modelError('local_model_unknown', `Unknown local model: ${modelId}`);
    return model;
  }

  modelDirectory(model) {
    return path.join(this.root, model.id, model.version);
  }

  filePath(model, file) {
    return path.join(this.modelDirectory(model), ...file.path.split('/'));
  }

  markerPath(model) {
    return path.join(this.modelDirectory(model), '.verified.json');
  }

  _stat(filePath) {
    try { return fs.statSync(filePath); } catch { return null; }
  }

  _markerIsCurrent(model) {
    try {
      const marker = JSON.parse(fs.readFileSync(this.markerPath(model), 'utf8'));
      return marker.version === model.version && model.files.every((file) => {
        const stat = this._stat(this.filePath(model, file));
        return stat?.isFile() && stat.size === file.size && marker.files?.[file.path] === file.sha256;
      });
    } catch {
      return false;
    }
  }

  _byteCounts(model) {
    let installedBytes = 0;
    let downloadedBytes = 0;
    for (const file of model.files) {
      const installed = this._stat(this.filePath(model, file));
      const installedSize = installed?.isFile() ? Math.min(installed.size, file.size) : 0;
      installedBytes += installedSize;
      const partial = this._stat(`${this.filePath(model, file)}.partial`);
      const partialSize = partial?.isFile() ? Math.min(partial.size, file.size) : 0;
      downloadedBytes += installedSize || partialSize;
    }
    return { installedBytes, downloadedBytes };
  }

  _hasArtifacts(model) {
    return Boolean(this._stat(this.markerPath(model))) || model.files.some((file) => (
      Boolean(this._stat(this.filePath(model, file))) || Boolean(this._stat(`${this.filePath(model, file)}.partial`))
    ));
  }

  status() {
    const models = {};
    for (const model of this.manifest.models) {
      const downloadBytes = model.files.reduce((sum, file) => sum + file.size, 0);
      const operation = this.operations.get(model.id);
      const markerReady = this._markerIsCurrent(model);
      const failure = this.failures.get(model.id) || null;
      let phase;
      if (operation) phase = operation.phase;
      else if (failure?.phase === 'repair-needed') phase = 'repair-needed';
      else if (failure) phase = 'failed';
      else if (markerReady) phase = 'ready';
      else if (this._hasArtifacts(model)) phase = 'repair-needed';
      else phase = 'not-installed';
      const counts = this._byteCounts(model);
      models[model.id] = {
        id: model.id,
        displayName: model.displayName,
        purpose: model.purpose,
        expectedDevice: model.expectedDevice,
        version: model.version,
        downloadBytes,
        installedBytes: counts.installedBytes,
        downloadedBytes: operation?.downloadedBytes ?? counts.downloadedBytes,
        phase,
        ready: phase === 'ready',
        repairRecommended: phase === 'repair-needed',
        error: failure?.error || null,
      };
    }
    return { runtimeVersion: this.manifest.runtimeVersion, models };
  }

  _emit(modelId, phase, downloadedBytes, totalBytes) {
    const operation = this.operations.get(modelId);
    if (operation) {
      operation.phase = phase;
      operation.downloadedBytes = downloadedBytes;
    }
    this.onProgress({ modelId, phase, downloadedBytes, completedBytes: downloadedBytes, totalBytes });
  }

  _recordFailure(modelId, error, phase = 'failed') {
    this.failures.set(modelId, { phase, error: serializableError(error) });
  }

  async _withMutation(modelId, phase, operation) {
    const model = this.model(modelId);
    if (this.sessionActive()) throw modelError('meeting_active', 'Local models cannot change during a meeting');
    if (this.operations.has(modelId)) {
      throw modelError('local_model_mutation_active', 'This model already has an active operation');
    }
    this.operations.set(modelId, { phase, downloadedBytes: this._byteCounts(model).downloadedBytes });
    try {
      return await operation(model);
    } finally {
      this.operations.delete(modelId);
    }
  }

  async _invalidateMarker(model) {
    await fsp.rm(this.markerPath(model), { force: true });
  }

  async _writeMarker(model) {
    const marker = {
      version: model.version,
      files: Object.fromEntries(model.files.map((file) => [file.path, file.sha256])),
    };
    const markerPath = this.markerPath(model);
    const temporary = `${markerPath}.${process.pid}.tmp`;
    await fsp.mkdir(path.dirname(markerPath), { recursive: true });
    await fsp.writeFile(temporary, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temporary, markerPath);
  }

  async _fileIsValid(model, file) {
    const destination = this.filePath(model, file);
    try {
      const stat = await fsp.stat(destination);
      return stat.isFile() && stat.size === file.size && await sha256(destination) === file.sha256;
    } catch {
      return false;
    }
  }

  async _verifyFiles(model) {
    const totalBytes = model.files.reduce((sum, file) => sum + file.size, 0);
    let verifiedBytes = 0;
    this._emit(model.id, 'verifying', verifiedBytes, totalBytes);
    try {
      for (const file of model.files) {
        const destination = this.filePath(model, file);
        let stat;
        try { stat = await fsp.stat(destination); } catch {
          throw modelError('local_model_file_missing', `Missing model file: ${file.path}`);
        }
        if (!stat.isFile() || stat.size !== file.size) {
          throw modelError('local_model_size_mismatch', `Size mismatch for ${file.path}`);
        }
        if (await sha256(destination) !== file.sha256) {
          throw modelError('local_model_hash_mismatch', `Hash mismatch for ${file.path}`);
        }
        verifiedBytes += file.size;
        this._emit(model.id, 'verifying', verifiedBytes, totalBytes);
      }
    } catch (error) {
      await this._invalidateMarker(model);
      throw error;
    }
    await this._writeMarker(model);
  }

  async _downloadFiles(model) {
    const totalBytes = model.files.reduce((sum, file) => sum + file.size, 0);
    let completedBytes = 0;
    for (const file of model.files) {
      const destination = this.filePath(model, file);
      const partial = `${destination}.partial`;
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      if (await this._fileIsValid(model, file)) {
        completedBytes += file.size;
        this._emit(model.id, 'downloading', completedBytes, totalBytes);
        continue;
      }
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
      let response;
      try {
        response = await this.fetchImpl(file.url, { headers: offset ? { Range: `bytes=${offset}-` } : {} });
      } catch (error) {
        throw modelError('local_model_download_failed', `Download failed for ${file.path}: ${error.message || 'network error'}`);
      }
      if (!response?.ok || !response.body) {
        throw modelError('local_model_download_failed', `Download failed with HTTP ${response?.status ?? 'unknown'}`);
      }
      const resumed = offset > 0 && response.status === 206;
      if (!resumed) offset = 0;
      let downloadedBytes = offset;
      this._emit(model.id, 'downloading', completedBytes + downloadedBytes, totalBytes);
      const progress = new Transform({
        transform: (chunk, _encoding, callback) => {
          downloadedBytes += chunk.length;
          this._emit(model.id, 'downloading', completedBytes + downloadedBytes, totalBytes);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(response.body),
          progress,
          fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w', mode: 0o600 }),
        );
      } catch (error) {
        throw modelError('local_model_download_failed', `Download failed for ${file.path}: ${error.message || 'stream error'}`);
      }
      const stat = await fsp.stat(partial);
      if (stat.size !== file.size) {
        await fsp.rm(partial, { force: true });
        throw modelError('local_model_size_mismatch', `Size mismatch for ${file.path}`);
      }
      if (await sha256(partial) !== file.sha256) {
        await fsp.rm(partial, { force: true });
        throw modelError('local_model_hash_mismatch', `Hash mismatch for ${file.path}`);
      }
      await fsp.rm(destination, { force: true });
      await fsp.rename(partial, destination);
      completedBytes += file.size;
      if (downloadedBytes !== file.size) this._emit(model.id, 'downloading', completedBytes, totalBytes);
    }
  }

  async download(modelId) {
    return this._withMutation(modelId, 'downloading', async (model) => {
      try {
        await this._downloadFiles(model);
        await this._verifyFiles(model);
        this.failures.delete(model.id);
        const totalBytes = model.files.reduce((sum, file) => sum + file.size, 0);
        this._emit(model.id, 'ready', totalBytes, totalBytes);
        return this.status().models[model.id];
      } catch (error) {
        this._recordFailure(model.id, error);
        throw error;
      }
    });
  }

  async verify(modelId) {
    return this._withMutation(modelId, 'verifying', async (model) => {
      try {
        await this._verifyFiles(model);
        this.failures.delete(model.id);
        const totalBytes = model.files.reduce((sum, file) => sum + file.size, 0);
        this._emit(model.id, 'ready', totalBytes, totalBytes);
        return this.status().models[model.id];
      } catch (error) {
        this._recordFailure(model.id, error, 'repair-needed');
        throw error;
      }
    });
  }

  async repair(modelId) {
    return this._withMutation(modelId, 'verifying', async (model) => {
      try {
        for (const file of model.files) {
          const destination = this.filePath(model, file);
          const partial = `${destination}.partial`;
          if (await this._fileIsValid(model, file)) {
            await fsp.rm(partial, { force: true });
          } else {
            await fsp.rm(destination, { force: true });
            await fsp.rm(partial, { force: true });
          }
        }
        await this._invalidateMarker(model);
        await this._downloadFiles(model);
        await this._verifyFiles(model);
        this.failures.delete(model.id);
        const totalBytes = model.files.reduce((sum, file) => sum + file.size, 0);
        this._emit(model.id, 'ready', totalBytes, totalBytes);
        return this.status().models[model.id];
      } catch (error) {
        this._recordFailure(model.id, error);
        throw error;
      }
    });
  }

  async remove(modelId) {
    return this._withMutation(modelId, 'not-installed', async (model) => {
      try {
        await fsp.rm(this.modelDirectory(model), { recursive: true, force: true });
        this.failures.delete(model.id);
        return this.status().models[model.id];
      } catch (error) {
        this._recordFailure(model.id, error);
        throw error;
      }
    });
  }
}

module.exports = { LocalModelManager, sha256 };
