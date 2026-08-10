const path = require('path');


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
}) {
  const runtimeRoot = isPackaged
    ? path.win32.join(resourcesPath, 'local-inference-host')
    : path.win32.join(appPath, 'artifacts', 'local-inference-host');
  const modelRoot = isPackaged
    ? path.win32.join(userDataPath, 'local-models')
    : path.win32.join(appPath, 'native', 'local-inference-host', 'models');
  return {
    runtimeRoot,
    executablePath: path.win32.join(runtimeRoot, 'twinscript-local-inference.exe'),
    llamaBinaryPath: path.win32.join(runtimeRoot, 'llama', 'llama-server.exe'),
    whisperModelPath: modelLaunchPath(modelRoot, manifest, 'whisper-small'),
    hyMt2ModelPath: modelLaunchPath(modelRoot, manifest, 'hy-mt2-1.8b'),
    cachePath: path.win32.join(userDataPath, 'local-inference-cache'),
    modelRoot,
  };
}

module.exports = {
  resolveLocalInferencePaths,
};
