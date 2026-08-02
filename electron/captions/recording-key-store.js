const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// One installation-wide key that protects temporary meeting-audio backups.
//
// Deliberately separate from EvaluationRecorder's key: meeting backup is a
// distinct component with its own directory, manifest schema, and retention
// lifecycle (evaluation recordings are a developer-only validation feature;
// meeting records are the product's core backup path).
//
// The key is decrypted through Electron `safeStorage` once per app launch and
// cached in memory. Chunk-level encryption must never touch safeStorage again
// per chunk or per meeting — DPAPI/Keychain calls are comparatively slow and a
// live session can produce thousands of chunks.

const KEY_BYTES = 32;

class RecordingKeyStore {
  constructor({ app, safeStorage, directory }) {
    this.app = app;
    this.safeStorage = safeStorage;
    this.directory = directory || path.join(app.getPath('userData'), 'meeting-records');
    this.keyPath = path.join(this.directory, 'installation-key.enc');
    this.cachedKey = null;
  }

  async secureStorageAvailable() {
    return typeof this.safeStorage.isAsyncEncryptionAvailable === 'function'
      ? this.safeStorage.isAsyncEncryptionAvailable()
      : this.safeStorage.isEncryptionAvailable();
  }

  /**
   * Return the 32-byte installation key, creating and protecting one on first
   * use. Cached after the first successful call for the life of the process.
   */
  async getKey() {
    if (this.cachedKey) return this.cachedKey;
    if (!(await this.secureStorageAvailable())) {
      throw new Error('Encrypted meeting-audio backup is unavailable on this device');
    }
    fs.mkdirSync(this.directory, { recursive: true });
    if (fs.existsSync(this.keyPath)) {
      const protectedKey = fs.readFileSync(this.keyPath);
      const encoded =
        typeof this.safeStorage.decryptStringAsync === 'function'
          ? (await this.safeStorage.decryptStringAsync(protectedKey)).result
          : this.safeStorage.decryptString(protectedKey);
      this.cachedKey = Buffer.from(encoded, 'base64');
      return this.cachedKey;
    }
    const key = crypto.randomBytes(KEY_BYTES);
    const protectedKey =
      typeof this.safeStorage.encryptStringAsync === 'function'
        ? await this.safeStorage.encryptStringAsync(key.toString('base64'))
        : this.safeStorage.encryptString(key.toString('base64'));
    fs.writeFileSync(this.keyPath, protectedKey, { mode: 0o600 });
    this.cachedKey = key;
    return this.cachedKey;
  }

  /** Zero the cached key. Call at app quit; never reuse the store afterward. */
  destroy() {
    this.cachedKey?.fill(0);
    this.cachedKey = null;
  }
}

module.exports = { RecordingKeyStore, KEY_BYTES };
