const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { LlamaTranslationServer } = require('./llama-translation-client');


function child() {
  const process = new EventEmitter();
  process.stderr = new EventEmitter();
  process.exitCode = null;
  process.kill = () => { process.exitCode = 0; };
  return process;
}

test('persistent llama.cpp server starts on loopback with CPU-only allocation', async () => {
  const spawned = [];
  const server = new LlamaTranslationServer({
    binaryPath: 'C:\\runtime\\llama-server.exe',
    modelPath: 'C:\\models\\hy-mt2.gguf',
    allocatePort: async () => 23841,
    spawn: (binary, args, options) => {
      spawned.push({ binary, args, options });
      return child();
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });

  await server.start();
  assert.equal(spawned[0].binary, 'C:\\runtime\\llama-server.exe');
  assert.deepEqual(spawned[0].args.slice(0, 8), [
    '-m', 'C:\\models\\hy-mt2.gguf', '--host', '127.0.0.1',
    '--port', '23841', '--no-webui', '-c',
  ]);
  assert.ok(spawned[0].args.includes('0'));
  assert.equal(spawned[0].options.windowsHide, true);
});

test('translation uses the Hy-MT2 model-card prompt and maps truthful provenance', async () => {
  let posted;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    fetchImpl: async (url, options) => {
      posted = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: ' 保持 ±0.2 mm。 ' } }],
          usage: { prompt_tokens: 21, completion_tokens: 8 },
        }),
      };
    },
  });
  server.port = 23841;
  server.started = true;

  const result = await server.translate('translate.final', {
    utteranceId: 'u1', sourceRevision: 3, sourceLanguage: 'English',
    targetLanguage: 'Chinese', text: 'Hold ±0.2 mm.',
  });
  const body = JSON.parse(posted.options.body);
  assert.equal(body.messages[0].content,
    'Translate the following text into Chinese. Note that you should only output the translated result without any additional explanation: Hold ±0.2 mm.');
  assert.equal(body.temperature, 0);
  assert.equal(result.text, '保持 ±0.2 mm。');
  assert.equal(result.authoritative, true);
  assert.equal(result.actualDevice, 'CPU');
  assert.equal(result.completionTokens, 8);
});

test('protected literals are masked for inference and restored exactly', async () => {
  let posted;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    fetchImpl: async (_url, options) => {
      posted = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '设为 ⟦TS0⟧。' } }] }),
      };
    },
  });
  server.port = 1;
  server.started = true;

  const result = await server.translate('translate.final', {
    targetLanguage: 'Chinese', text: 'Set to 24 VDC.', protectedTokens: ['24 VDC'],
  });
  assert.match(posted.messages[0].content, /Set to ⟦TS0⟧\./);
  assert.equal(result.text, '设为 24 VDC。');
});
