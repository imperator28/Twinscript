const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const requiredEnvironment = [
  'TWINSCRIPT_LOCAL_HOST',
  'TWINSCRIPT_WHISPER_MODEL',
  'TWINSCRIPT_WHISPER_PCM24',
  'TWINSCRIPT_LLAMA_CPU_SERVER',
  'TWINSCRIPT_LLAMA_CUDA_SERVER',
  'TWINSCRIPT_HYMT2_MODEL',
];
const savedEnvironment = Object.fromEntries(requiredEnvironment.map((name) => [name, process.env[name]]));
for (const name of requiredEnvironment) delete process.env[name];
const { readPcm16Mono24, supervisorOptionsFromEnvironment } = require('./smoke-local-inference.cjs');
for (const [name, value] of Object.entries(savedEnvironment)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('smoke wiring maps separate CPU and CUDA runtime paths without any cloud client', () => {
  const options = supervisorOptionsFromEnvironment({
    TWINSCRIPT_LOCAL_HOST: 'C:\\artifacts\\twinscript-local-inference.exe',
    TWINSCRIPT_WHISPER_MODEL: 'C:\\models\\whisper',
    TWINSCRIPT_LOCAL_CACHE: 'C:\\cache',
    TWINSCRIPT_LLAMA_CPU_SERVER: 'C:\\artifacts\\llama\\cpu\\llama-server.exe',
    TWINSCRIPT_LLAMA_CUDA_SERVER: 'C:\\artifacts\\llama\\cuda\\llama-server.exe',
    TWINSCRIPT_HYMT2_MODEL: 'C:\\models\\hy-mt2.gguf',
    TWINSCRIPT_HYMT2_CUDA: '1',
  }, path.win32);

  assert.equal(options.llamaCpuBinaryPath, 'C:\\artifacts\\llama\\cpu\\llama-server.exe');
  assert.equal(options.llamaCudaBinaryPath, 'C:\\artifacts\\llama\\cuda\\llama-server.exe');
  assert.equal(options.cudaEnabled, true);
  assert.equal('llamaBinaryPath' in options, false);
});

test('smoke wiring supports intentional CPU mode without a CUDA runtime', () => {
  const options = supervisorOptionsFromEnvironment({
    TWINSCRIPT_LOCAL_HOST: 'C:\\artifacts\\twinscript-local-inference.exe',
    TWINSCRIPT_WHISPER_MODEL: 'C:\\models\\whisper',
    TWINSCRIPT_LLAMA_CPU_SERVER: 'C:\\artifacts\\llama\\cpu\\llama-server.exe',
    TWINSCRIPT_HYMT2_MODEL: 'C:\\models\\hy-mt2.gguf',
  }, path.win32);

  assert.equal(options.llamaCudaBinaryPath, null);
  assert.equal(options.cudaEnabled, false);
});

test('Whisper smoke accepts a mono 24 kHz 16-bit PCM WAV fixture', () => {
  const fs = require('node:fs');
  const pcm = readPcm16Mono24(path.resolve('benchmark/test-speech-silence-speech.wav'));
  assert.ok(pcm.length > 200_000);
  assert.equal(pcm.length % 2, 0);
  assert.notEqual(pcm.subarray(0, 4).toString('ascii'), 'RIFF');
});
