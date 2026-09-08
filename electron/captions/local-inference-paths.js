const path = require('path');
const fs = require('fs');
const { verifyRuntimeManifest } = require('./local-inference-supervisor');

function installedRuntimeRoots({ userDataPath, fsImpl = fs }) {
  const root = path.join(userDataPath, 'local-inference-host');
  try {
    return fsImpl.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
      .map(entry => path.join(root, entry.name));
  } catch { return []; }
}


function modelLaunchPath(modelRoot, manifest, modelId) {
  const model = manifest?.models?.find((candidate) => candidate.id === modelId);
  if (!model) return null;
  const base = path.win32.join(modelRoot, model.id, model.version);
  return model.launchPath === '.' ? base : path.win32.join(base, ...model.launchPath.split('/'));
}

function resolveLocalInferencePaths({
  isPackaged,
  resourcesPath,
  appPath,
  userDataPath,
  manifest = null,
  fsImpl = fs,
  platform = process.platform,
  verifyRuntime = verifyRuntimeManifest,
}) {
  const fallbackRoot = isPackaged
    ? path.win32.join(resourcesPath, 'local-inference-host')
    : path.win32.join(appPath, 'artifacts', 'local-inference-host');
  const runtimeRoot = platform !== 'win32' ? null : (
    installedRuntimeRoots({ userDataPath, fsImpl }).find(root => verifyRuntime(path.join(root, 'twinscript-local-inference.exe'), fsImpl))
    || ((!isPackaged || verifyRuntime(path.win32.join(fallbackRoot, 'twinscript-local-inference.exe'), fsImpl)) ? fallbackRoot : null)
  );
  const modelRoot = isPackaged
    ? path.win32.join(userDataPath, 'local-models')
    : path.win32.join(appPath, 'native', 'local-inference-host', 'models');
  return {
    runtimeRoot,
    executablePath: runtimeRoot ? path.win32.join(runtimeRoot, 'twinscript-local-inference.exe') : null,
    llamaCpuBinaryPath: runtimeRoot ? path.win32.join(runtimeRoot, 'llama', 'cpu', 'llama-server.exe') : null,
    llamaCudaBinaryPath: runtimeRoot ? path.win32.join(runtimeRoot, 'llama', 'cuda', 'llama-server.exe') : null,
    whisperModelPath: modelLaunchPath(modelRoot, manifest, 'whisper-small'),
    hyMt2ModelPath: modelLaunchPath(modelRoot, manifest, 'hy-mt2-1.8b'),
    cachePath: path.win32.join(userDataPath, 'local-inference-cache'),
    modelRoot,
  };
}

module.exports = {
  resolveLocalInferencePaths,
  installedRuntimeRoots,
};
