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

test('translation has a bounded timeout even when no caller signal is supplied', async () => {
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    requestTimeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  server.port = 1;
  server.started = true;

  await assert.rejects(server.translate('translate.final', {
    targetLanguage: 'Chinese', text: 'Bound this request.',
  }), { code: 'local_translation_timeout' });
});

test('translation forwards an already-aborted caller signal', async () => {
  const caller = new AbortController();
  caller.abort();
  let forwardedSignal;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    fetchImpl: async (_url, options) => {
      forwardedSignal = options.signal;
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  server.started = true;
  server.port = 8080;

  await assert.rejects(server.translate('translate.final', {
    utteranceId: 'u-aborted',
    text: 'hello',
    targetLanguage: 'Chinese',
  }, { signal: caller.signal }), { name: 'AbortError' });
  assert.equal(forwardedSignal.aborted, true);
});

test('llama.cpp exit clears readiness and the next translation restarts once', async () => {
  const children = [];
  let completions = 0;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    allocatePort: async () => 8080 + children.length,
    spawn: () => {
      const spawned = child();
      children.push(spawned);
      return spawned;
    },
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) return { ok: true, status: 200 };
      completions += 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: `result ${completions}` } }] }),
      };
    },
  });

  await server.start();
  children[0].exitCode = 1;
  children[0].emit('close', 1);
  assert.equal(server.health().ready, false);

  const result = await server.translate('translate.final', {
    targetLanguage: 'Chinese', text: 'restart me',
  });
  assert.equal(children.length, 2);
  assert.equal(result.text, 'result 1');

  children[1].exitCode = 1;
  children[1].emit('close', 1);
  await assert.rejects(server.translate('translate.final', {
    targetLanguage: 'Chinese', text: 'do not restart forever',
  }), { code: 'local_translation_restart_exhausted' });
});
