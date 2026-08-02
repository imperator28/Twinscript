const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecordingKeyStore, KEY_BYTES } = require('./recording-key-store');

function tempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-key-store-'));
  return { app: { getPath: () => dir }, dir };
}

// A minimal safeStorage double using a reversible XOR "cipher" so round trips
// are verifiable without touching the OS keychain/DPAPI.
function fakeSafeStorage({ async = true, available = true } = {}) {
  const encrypt = (value) => Buffer.from(`enc:${value}`, 'utf8');
  const decrypt = (buffer) => buffer.toString('utf8').replace(/^enc:/, '');
  const calls = { encrypt: 0, decrypt: 0, availability: 0 };
  const base = {
    isEncryptionAvailable: () => {
      calls.availability += 1;
      return available;
    },
  };
  if (async) {
    return {
      ...base,
      isAsyncEncryptionAvailable: async () => {
        calls.availability += 1;
        return available;
      },
      encryptStringAsync: async (value) => {
        calls.encrypt += 1;
        return encrypt(value);
      },
      decryptStringAsync: async (buffer) => {
        calls.decrypt += 1;
        return { result: decrypt(buffer) };
      },
      calls,
    };
  }
  return {
    ...base,
    encryptString: (value) => {
      calls.encrypt += 1;
      return encrypt(value);
    },
    decryptString: (buffer) => {
      calls.decrypt += 1;
      return decrypt(buffer);
    },
    calls,
  };
}

test('creates a 32-byte key on first use and protects it on disk', async () => {
  const { app } = tempApp();
  const safeStorage = fakeSafeStorage();
  const store = new RecordingKeyStore({ app, safeStorage });

  const key = await store.getKey();
  assert.equal(key.length, KEY_BYTES);
  assert.equal(fs.existsSync(store.keyPath), true);
  assert.equal(safeStorage.calls.encrypt, 1);
});

test('a second launch decrypts the same key rather than minting a new one', async () => {
  const { app } = tempApp();
  const safeStorage = fakeSafeStorage();
  const first = await new RecordingKeyStore({ app, safeStorage }).getKey();

  const secondStore = new RecordingKeyStore({ app, safeStorage });
  const second = await secondStore.getKey();

  assert.deepEqual(second, first);
  assert.equal(safeStorage.calls.decrypt, 1);
});

test('the key is cached in memory: safeStorage is touched once per launch', async () => {
  const { app } = tempApp();
  const safeStorage = fakeSafeStorage();
  const store = new RecordingKeyStore({ app, safeStorage });

  await store.getKey();
  await store.getKey();
  await store.getKey();

  assert.equal(safeStorage.calls.encrypt, 1);
  assert.equal(safeStorage.calls.decrypt, 0);
});

test('falls back to the synchronous safeStorage API when async is unavailable', async () => {
  const { app } = tempApp();
  const safeStorage = fakeSafeStorage({ async: false });
  const store = new RecordingKeyStore({ app, safeStorage });

  const key = await store.getKey();
  assert.equal(key.length, KEY_BYTES);
  assert.equal(safeStorage.calls.encrypt, 1);
});

test('refuses to operate when secure storage is unavailable on this device', async () => {
  const { app } = tempApp();
  const safeStorage = fakeSafeStorage({ available: false });
  const store = new RecordingKeyStore({ app, safeStorage });

  await assert.rejects(() => store.getKey(), /unavailable/);
});

test('destroy zeroes the cached key and forces a fresh decrypt on next use', async () => {
  const { app } = tempApp();
  const safeStorage = fakeSafeStorage();
  const store = new RecordingKeyStore({ app, safeStorage });

  const key = await store.getKey();
  const copy = Buffer.from(key);
  store.destroy();
  assert.equal(key.every((byte) => byte === 0), true);

  const again = await store.getKey();
  assert.deepEqual(again, copy);
  assert.equal(safeStorage.calls.decrypt, 1);
});

test('the key file is written with user-only permissions where supported', async () => {
  if (process.platform === 'win32') return; // POSIX mode bits are best-effort on Windows.
  const { app } = tempApp();
  const store = new RecordingKeyStore({ app, safeStorage: fakeSafeStorage() });
  await store.getKey();
  const mode = fs.statSync(store.keyPath).mode & 0o777;
  assert.equal(mode, 0o600);
});
