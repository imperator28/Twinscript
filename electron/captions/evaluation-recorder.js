const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORMAT_VERSION = 1;

function atomicWrite(filePath, contents, options) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, contents, options);
  fs.renameSync(temporary, filePath);
}

class EvaluationRecorder {
  constructor({ app, safeStorage }) {
    this.app = app;
    this.safeStorage = safeStorage;
    this.directory = path.join(app.getPath('userData'), 'evaluations');
    this.keyPath = path.join(this.directory, 'installation-key.enc');
    this.current = null;
    this.queue = Promise.resolve();
  }

  async secureStorageAvailable() {
    return typeof this.safeStorage.isAsyncEncryptionAvailable === 'function'
      ? this.safeStorage.isAsyncEncryptionAvailable()
      : this.safeStorage.isEncryptionAvailable();
  }

  async dataKey() {
    if (!(await this.secureStorageAvailable())) {
      throw new Error('Encrypted evaluation recording is unavailable');
    }
    fs.mkdirSync(this.directory, { recursive: true });
    if (fs.existsSync(this.keyPath)) {
      const protectedKey = fs.readFileSync(this.keyPath);
      const value =
        typeof this.safeStorage.decryptStringAsync === 'function'
          ? (await this.safeStorage.decryptStringAsync(protectedKey)).result
          : this.safeStorage.decryptString(protectedKey);
      return Buffer.from(value, 'base64');
    }
    const key = crypto.randomBytes(32);
    const protectedKey =
      typeof this.safeStorage.encryptStringAsync === 'function'
        ? await this.safeStorage.encryptStringAsync(key.toString('base64'))
        : this.safeStorage.encryptString(key.toString('base64'));
    fs.writeFileSync(this.keyPath, protectedKey, { mode: 0o600 });
    return key;
  }

  async start({ sessionId, settings }) {
    this.prune(settings.recordingRetentionDays || 7);
    const key = await this.dataKey();
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${sessionId.slice(0, 8)}`;
    const filePath = path.join(this.directory, `${id}.bcr`);
    const manifestPath = path.join(this.directory, `${id}.json`);
    this.current = {
      id,
      sessionId,
      startedAt: Date.now(),
      filePath,
      manifestPath,
      key,
      settings: {
        primaryProfile: settings.primaryProfile,
        shadowProfile: settings.shadowProfile,
        delayProfile: settings.delayProfile,
        vadEnabled: settings.vadEnabled,
        fastPath: settings.fastPath,
      },
      counts: {},
    };
    fs.writeFileSync(filePath, '', { mode: 0o600 });
    this.writeManifest();
    return { id };
  }

  writeManifest(endedAt) {
    if (!this.current) return;
    const { id, sessionId, startedAt, manifestPath, settings, counts } = this.current;
    atomicWrite(
      manifestPath,
      JSON.stringify(
        {
          version: FORMAT_VERSION,
          id,
          sessionId,
          startedAt,
          ...(endedAt ? { endedAt } : {}),
          settings,
          counts,
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  record(kind, payload, at = Date.now()) {
    if (!this.current) return;
    const current = this.current;
    current.counts[kind] = (current.counts[kind] || 0) + 1;
    const plaintext = Buffer.from(JSON.stringify(payload));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', current.key, iv);
    const aad = Buffer.from(`${FORMAT_VERSION}:${current.sessionId}:${kind}:${at}`);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const line = `${JSON.stringify({
      version: FORMAT_VERSION,
      sessionId: current.sessionId,
      kind,
      at,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    })}\n`;
    this.queue = this.queue.then(() =>
      fs.promises.appendFile(current.filePath, line, { encoding: 'utf8', mode: 0o600 }),
    );
  }

  async stop() {
    if (!this.current) return null;
    await this.queue;
    this.writeManifest(Date.now());
    const result = { id: this.current.id };
    this.current.key.fill(0);
    this.current = null;
    this.queue = Promise.resolve();
    return result;
  }

  list() {
    try {
      return fs
        .readdirSync(this.directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((left, right) => right.startedAt - left.startedAt);
    } catch {
      return [];
    }
  }

  prune(retentionDays) {
    const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
    for (const manifest of this.list()) {
      if (manifest.startedAt >= cutoff) continue;
      for (const extension of ['.json', '.bcr']) {
        try {
          fs.unlinkSync(path.join(this.directory, `${manifest.id}${extension}`));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  async read(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(id || ''))) {
      throw new Error('Invalid evaluation recording');
    }
    const key = await this.dataKey();
    const filePath = path.join(this.directory, `${id}.bcr`);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const result = [];
    try {
      for (let index = 0; index < lines.length; index += 1) {
        let record;
        try {
          record = JSON.parse(lines[index]);
        } catch (error) {
          if (index === lines.length - 1) break;
          throw error;
        }
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(record.iv, 'base64'),
        );
        decipher.setAAD(
          Buffer.from(
            `${record.version}:${record.sessionId}:${record.kind}:${record.at}`,
          ),
        );
        decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(record.data, 'base64')),
          decipher.final(),
        ]);
        result.push({
          kind: record.kind,
          at: record.at,
          payload: JSON.parse(plaintext.toString('utf8')),
        });
      }
      return result;
    } finally {
      key.fill(0);
    }
  }
}

module.exports = { EvaluationRecorder, FORMAT_VERSION, atomicWrite };
