const crypto = require('crypto');
const path = require('path');

const ALLOWED_MODEL_IDS = ['whisper-small', 'hy-mt2-1.8b'];
const MAX_VERSION_LENGTH = 128;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isSafeVersionSegment(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_VERSION_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.endsWith('.') &&
    !WINDOWS_DEVICE_NAME.test(value)
  );
}

function isHttpsUrlWithHostname(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function invalidManifest(message) {
  const error = new Error(message);
  error.code = 'local_manifest_invalid';
  return error;
}

function validateManifest(manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    !isSafeVersionSegment(manifest.runtimeVersion) ||
    !Array.isArray(manifest.models)
  ) {
    throw invalidManifest('Unsupported local model manifest');
  }
  const ids = new Set();
  for (const model of manifest.models) {
    if (
      !model?.id || !isSafeVersionSegment(model.version) || !Array.isArray(model.files) || !model.files.length ||
      !['displayName', 'purpose', 'license', 'source'].every((field) => (
        typeof model[field] === 'string' && model[field].trim()
      )) ||
      !['NPU', 'GPU', 'CPU'].includes(model.expectedDevice) ||
      !Number.isSafeInteger(model.unpackedSize) || model.unpackedSize < 0
    ) {
      throw invalidManifest('Local model entry is incomplete');
    }
    if (!ALLOWED_MODEL_IDS.includes(model.id)) throw invalidManifest(`Unknown local model: ${model.id}`);
    if (ids.has(model.id)) throw invalidManifest(`Duplicate local model: ${model.id}`);
    ids.add(model.id);
    const filePaths = new Set();
    for (const file of model.files) {
      const declaredPath = String(file?.path || '').replaceAll('\\', '/');
      const normalized = path.posix.normalize(declaredPath);
      if (
        !normalized || normalized !== declaredPath || normalized.startsWith('../') ||
        normalized.startsWith('/') || /[:*?"<>|\0-\x1f]/.test(normalized) ||
        filePaths.has(normalized.toLowerCase()) ||
        !isHttpsUrlWithHostname(file?.url) ||
        !Number.isSafeInteger(file?.size) || file.size < 0 ||
        !/^[a-f0-9]{64}$/i.test(file?.sha256 || '')
      ) {
        throw invalidManifest(`Invalid file entry for ${model.id}`);
      }
      filePaths.add(normalized.toLowerCase());
    }
    if (
      typeof model.launchPath !== 'string' ||
      (model.launchPath !== '.' && !model.files.some((file) => file.path === model.launchPath))
    ) {
      throw invalidManifest(`Invalid launch path for ${model.id}`);
    }
  }
  if (ids.size !== ALLOWED_MODEL_IDS.length || ALLOWED_MODEL_IDS.some((id) => !ids.has(id))) {
    throw invalidManifest('Local model catalog is incomplete');
  }
  return manifest;
}

function loadManifest({ json, signature, publicKey, packaged }) {
  let manifest;
  try {
    manifest = typeof json === 'string' ? JSON.parse(json) : structuredClone(json);
  } catch {
    throw invalidManifest('Local model manifest is not valid JSON');
  }
  validateManifest(manifest);
  if (packaged) {
    let valid = false;
    try {
      valid = Boolean(signature && publicKey && crypto.verify(
        null,
        Buffer.from(canonicalJson(manifest)),
        publicKey,
        Buffer.from(signature, 'base64'),
      ));
    } catch {
      valid = false;
    }
    if (!valid) throw invalidManifest('Local model manifest signature is invalid');
  }
  return manifest;
}

module.exports = { ALLOWED_MODEL_IDS, canonicalJson, loadManifest, validateManifest };
