const fs = require('fs');
const path = require('path');

function parseDevelopmentKey(contents) {
  const match = String(contents || '').match(
    /(?:^|\n)\s*OPENAI_API_KEY\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\r\n#]*))/,
  );
  return (match?.[1] || match?.[2] || match?.[3] || '').trim();
}

class CredentialStore {
  constructor({ app, safeStorage, fetchImpl = global.fetch }) {
    this.app = app;
    this.safeStorage = safeStorage;
    this.fetch = fetchImpl;
    this.directory = path.join(app.getPath('userData'), 'credentials');
    this.filePath = path.join(this.directory, 'openai.enc');
    this.cachedKey = '';
    this.pendingGet = null;
  }

  getDevelopmentKey() {
    if (this.app.isPackaged) return '';
    if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
    try {
      return parseDevelopmentKey(
        fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8'),
      );
    } catch {
      return '';
    }
  }

  async get() {
    const developmentKey = this.getDevelopmentKey();
    if (developmentKey) return developmentKey;
    if (this.cachedKey) return this.cachedKey;
    if (this.pendingGet) return this.pendingGet;
    this.pendingGet = (async () => {
      let encrypted;
      try {
        encrypted = fs.readFileSync(this.filePath);
      } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
      }
      try {
        if (typeof this.safeStorage.decryptStringAsync === 'function') {
          const decrypted = await this.safeStorage.decryptStringAsync(encrypted);
          this.cachedKey = String(decrypted.result || '').trim();
          if (decrypted.shouldReEncrypt && this.cachedKey) {
            await this.set(this.cachedKey);
          }
          return this.cachedKey;
        }
        this.cachedKey = this.safeStorage.decryptString(encrypted).trim();
        return this.cachedKey;
      } catch {
        const error = new Error(
          'The saved API key could not be unlocked from macOS Keychain.',
        );
        error.code = 'credential_unlock_failed';
        throw error;
      }
    })();
    try {
      return await this.pendingGet;
    } finally {
      this.pendingGet = null;
    }
  }

  async status() {
    const development = Boolean(this.getDevelopmentKey());
    return {
      available: development || fs.existsSync(this.filePath),
      source: development ? 'development-environment' : fs.existsSync(this.filePath) ? 'secure-storage' : 'missing',
      // A status read happens on every launch and must not unlock Keychain.
      // Actual availability is checked immediately before saving a credential.
      encryptionAvailable: ['darwin', 'win32'].includes(process.platform),
    };
  }

  async set(value) {
    const key = String(value || '').trim();
    if (!key) throw new Error('API key cannot be empty');
    const available =
      typeof this.safeStorage.isAsyncEncryptionAvailable === 'function'
        ? await this.safeStorage.isAsyncEncryptionAvailable()
        : this.safeStorage.isEncryptionAvailable();
    if (!available) throw new Error('Secure credential storage is unavailable');

    const encrypted =
      typeof this.safeStorage.encryptStringAsync === 'function'
        ? await this.safeStorage.encryptStringAsync(key)
        : this.safeStorage.encryptString(key);
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.filePath, encrypted, { mode: 0o600 });
    this.cachedKey = key;
    return this.status();
  }

  async delete() {
    this.cachedKey = '';
    this.pendingGet = null;
    try {
      fs.unlinkSync(this.filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.status();
  }

  async validate(value) {
    const key = String(value || (await this.get())).trim();
    if (!key) return { valid: false, error: 'No API key configured' };
    const response = await this.fetch(
      'https://api.openai.com/v1/models/gpt-live-transcribe',
      { headers: { Authorization: `Bearer ${key}` } },
    );
    if (!response.ok) {
      return {
        valid: false,
        error:
          response.status === 401
            ? 'OpenAI rejected this key'
            : `OpenAI validation failed (${response.status})`,
      };
    }
    return { valid: true };
  }
}

module.exports = { CredentialStore, parseDevelopmentKey };
