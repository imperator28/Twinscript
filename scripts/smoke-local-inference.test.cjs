const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const requiredEnvironment = [
  'TWINSCRIPT_LOCAL_HOST',
  'TWINSCRIPT_WHISPER_MODEL',
  'TWINSCRIPT_WHISPER_PCM24',
  'TWINSCRIPT_LLAMA_SERVER',
  'TWINSCRIPT_HYMT2_MODEL',
];
const savedEnvironment = Object.fromEntries(requiredEnvironment.map((name) => [name, process.env[name]]));
for (const name of requiredEnvironment) delete process.env[name];
const { supervisorOptionsFromEnvironment } = require('./smoke-local-inference.cjs');
for (const [name, value] of Object.entries(savedEnvironment)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('smoke wiring maps the legacy Llama environment variable to the CPU runtime path', () => {
  const options = supervisorOptionsFromEnvironment({
    TWINSCRIPT_LOCAL_HOST: 'C:\\artifacts\\twinscript-local-inference.exe',
    TWINSCRIPT_WHISPER_MODEL: 'C:\\models\\whisper',
    TWINSCRIPT_LOCAL_CACHE: 'C:\\cache',
    TWINSCRIPT_LLAMA_SERVER: 'C:\\artifacts\\llama\\cpu\\llama-server.exe',
    TWINSCRIPT_HYMT2_MODEL: 'C:\\models\\hy-mt2.gguf',
  }, path.win32);

  assert.equal(options.llamaCpuBinaryPath, 'C:\\artifacts\\llama\\cpu\\llama-server.exe');
  assert.equal('llamaBinaryPath' in options, false);
});
