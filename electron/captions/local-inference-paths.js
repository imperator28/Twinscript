const path = require('path');


const WHISPER_VERSION = '973afd24965f72e36ca33b3055d56a652f456b4d';
const HYMT2_VERSION = '1cd5208700acedef4ef93019b6cfc148b8522d45';
const HYMT2_FILENAME = 'Hy-MT2-1.8B-Q4_K_M.gguf';

function resolveLocalInferencePaths({
  isPackaged,
  resourcesPath,
  appPath,
  userDataPath,
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
    whisperModelPath: isPackaged
      ? path.win32.join(modelRoot, 'whisper-small', WHISPER_VERSION)
      : path.win32.join(modelRoot, 'whisper-small'),
    hyMt2ModelPath: isPackaged
      ? path.win32.join(modelRoot, 'hy-mt2-1.8b', HYMT2_VERSION, HYMT2_FILENAME)
      : path.win32.join(
          modelRoot,
          'source-snapshots',
          'hy-mt2-1.8b-gguf',
          HYMT2_FILENAME,
        ),
    cachePath: path.win32.join(userDataPath, 'local-inference-cache'),
    modelRoot,
  };
}

module.exports = {
  HYMT2_FILENAME,
  HYMT2_VERSION,
  WHISPER_VERSION,
  resolveLocalInferencePaths,
};
