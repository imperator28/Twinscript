const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveLocalInferencePaths } = require('./local-inference-paths');


test('development paths use staged runtime and validated local model artifacts', () => {
  const paths = resolveLocalInferencePaths({
    isPackaged: false,
    resourcesPath: 'unused',
    appPath: 'C:\\repo',
    userDataPath: 'C:\\user',
  });
  assert.equal(paths.executablePath,
    'C:\\repo\\artifacts\\local-inference-host\\twinscript-local-inference.exe');
  assert.equal(paths.whisperModelPath,
    'C:\\repo\\native\\local-inference-host\\models\\whisper-small');
  assert.match(paths.hyMt2ModelPath, /source-snapshots\\hy-mt2-1\.8b-gguf\\Hy-MT2-1\.8B-Q4_K_M\.gguf$/);
});

test('packaged paths keep runtime in resources and downloaded weights in user data', () => {
  const paths = resolveLocalInferencePaths({
    isPackaged: true,
    resourcesPath: 'C:\\Program Files\\Twinscript\\resources',
    appPath: 'unused',
    userDataPath: 'C:\\Users\\me\\AppData\\Roaming\\Twinscript',
  });
  assert.match(paths.executablePath, /resources\\local-inference-host\\twinscript-local-inference\.exe$/);
  assert.match(paths.llamaBinaryPath, /resources\\local-inference-host\\llama\\llama-server\.exe$/);
  assert.match(paths.whisperModelPath, /local-models\\whisper-small\\973afd24965f72e36ca33b3055d56a652f456b4d$/);
  assert.match(paths.hyMt2ModelPath, /local-models\\hy-mt2-1\.8b\\1cd5208700acedef4ef93019b6cfc148b8522d45\\Hy-MT2-1\.8B-Q4_K_M\.gguf$/);
});
