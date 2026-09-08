const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveLocalInferencePaths } = require('./local-inference-paths');

function catalog() {
  return {
    runtimeVersion: '2026.8.10',
    models: [
      { id: 'whisper-small', version: 'whisper-v2', launchPath: '.' },
      { id: 'hy-mt2-1.8b', version: 'hymt2-v2', launchPath: 'weights/model.gguf' },
    ],
  };
}

test('development paths use staged runtime and validated local model artifacts', () => {
  const paths = resolveLocalInferencePaths({
    isPackaged: false,
    platform: 'win32',
    resourcesPath: 'unused',
    appPath: 'C:\\repo',
    userDataPath: 'C:\\user',
    manifest: catalog(),
  });
  assert.equal(paths.executablePath,
    'C:\\repo\\artifacts\\local-inference-host\\twinscript-local-inference.exe');
  assert.equal(paths.llamaCpuBinaryPath,
    'C:\\repo\\artifacts\\local-inference-host\\llama\\cpu\\llama-server.exe');
  assert.equal(paths.llamaCudaBinaryPath,
    'C:\\repo\\artifacts\\local-inference-host\\llama\\cuda\\llama-server.exe');
  assert.equal(paths.whisperModelPath,
    'C:\\repo\\native\\local-inference-host\\models\\whisper-small\\whisper-v2');
  assert.equal(paths.hyMt2ModelPath,
    'C:\\repo\\native\\local-inference-host\\models\\hy-mt2-1.8b\\hymt2-v2\\weights\\model.gguf');
});

test('packaged paths keep runtime in resources and downloaded weights in user data', () => {
  const paths = resolveLocalInferencePaths({
    isPackaged: true,
    platform: 'win32', verifyRuntime: () => true,
    resourcesPath: 'C:\\Program Files\\Twinscript\\resources',
    appPath: 'unused',
    userDataPath: 'C:\\Users\\me\\AppData\\Roaming\\Twinscript',
    manifest: catalog(),
  });
  assert.match(paths.executablePath, /resources\\local-inference-host\\twinscript-local-inference\.exe$/);
  assert.match(paths.llamaCpuBinaryPath, /resources\\local-inference-host\\llama\\cpu\\llama-server\.exe$/);
  assert.match(paths.llamaCudaBinaryPath, /resources\\local-inference-host\\llama\\cuda\\llama-server\.exe$/);
  assert.match(paths.whisperModelPath, /local-models\\whisper-small\\whisper-v2$/);
  assert.match(paths.hyMt2ModelPath, /local-models\\hy-mt2-1\.8b\\hymt2-v2\\weights\\model\.gguf$/);
});

test('runtime paths remain defined while catalog-dependent model paths fail closed', () => {
  const paths = resolveLocalInferencePaths({
    isPackaged: true,
    platform: 'win32', verifyRuntime: () => true,
    resourcesPath: 'C:\\Program Files\\Twinscript\\resources',
    appPath: 'unused',
    userDataPath: 'C:\\Users\\me\\AppData\\Roaming\\Twinscript',
    manifest: null,
  });

  assert.match(paths.executablePath, /local-inference-host\\twinscript-local-inference\.exe$/);
  assert.match(paths.llamaCpuBinaryPath, /local-inference-host\\llama\\cpu\\llama-server\.exe$/);
  assert.match(paths.llamaCudaBinaryPath, /local-inference-host\\llama\\cuda\\llama-server\.exe$/);
  assert.equal(paths.whisperModelPath, null);
  assert.equal(paths.hyMt2ModelPath, null);
});

test('missing runtime returns null and an unsupported platform never selects Windows binaries', () => {
  const options = { isPackaged: true, resourcesPath: 'C:\\app', appPath: 'C:\\repo', userDataPath: 'C:\\user', verifyRuntime: () => false };
  assert.equal(resolveLocalInferencePaths({ ...options, platform: 'win32' }).runtimeRoot, null);
  assert.equal(resolveLocalInferencePaths({ ...options, platform: 'darwin', verifyRuntime: () => true }).runtimeRoot, null);
});

test('installed revisions are sorted numerically and invalid newest revisions are skipped', () => {
  const options = {
    isPackaged: true, platform: 'win32', resourcesPath: 'C:\\app', appPath: 'C:\\repo', userDataPath: 'C:\\user',
    fsImpl: { readdirSync: () => ['b9', 'b11', 'b10', '.staging'].map(name => ({ name, isDirectory: () => true })) },
    verifyRuntime: executable => executable.includes('b10'),
  };
  assert.match(resolveLocalInferencePaths(options).runtimeRoot, /b10$/);
});
