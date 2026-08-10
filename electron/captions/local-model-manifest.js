const crypto = require('crypto');
const path = require('path');

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
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.models)) {
    throw invalidManifest('Unsupported local model manifest');
  }
  const ids = new Set();
  for (const model of manifest.models) {
    if (!model?.id || !model.version || !Array.isArray(model.files) || !model.files.length) {
      throw invalidManifest('Local model entry is incomplete');
    }
    if (ids.has(model.id)) throw invalidManifest(`Duplicate local model: ${model.id}`);
    ids.add(model.id);
    const filePaths = new Set();
    for (const file of model.files) {
      const declaredPath = String(file.path || '').replaceAll('\\', '/');
      const normalized = path.posix.normalize(declaredPath);
      if (
        !normalized || normalized !== declaredPath || normalized.startsWith('../') ||
        normalized.startsWith('/') || /[:*?"<>|\0-\x1f]/.test(normalized) ||
        filePaths.has(normalized.toLowerCase()) ||
        !/^https:\/\//.test(file.url || '') ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        !/^[a-f0-9]{64}$/i.test(file.sha256 || '')
      ) {
        throw invalidManifest(`Invalid file entry for ${model.id}`);
      }
      filePaths.add(normalized.toLowerCase());
    }
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

module.exports = { canonicalJson, loadManifest, validateManifest };
