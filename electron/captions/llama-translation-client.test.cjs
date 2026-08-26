const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
  CPU_RUNTIME,
  CUDA_RUNTIME,
  LlamaTranslationServer,
} = require('./llama-translation-client');


function child({ onKill } = {}) {
  const process = new EventEmitter();
  process.stderr = new EventEmitter();
  process.exitCode = null;
  process.killCalls = [];
  process.kill = (signal) => {
    process.killCalls.push(signal);
    if (onKill) onKill(process, signal);
    else process.exitCode = 0;
  };
  return process;
}

function completion(text = ' translated ') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 21, completion_tokens: 8 },
    }),
  };
}

test('runtime descriptors and their launch arguments are immutable', () => {
  assert.equal(Object.isFrozen(CPU_RUNTIME), true);
  assert.equal(Object.isFrozen(CPU_RUNTIME.launchArgs), true);
  assert.equal(Object.isFrozen(CUDA_RUNTIME), true);
  assert.equal(Object.isFrozen(CUDA_RUNTIME.launchArgs), true);
  assert.deepEqual(CPU_RUNTIME, {
    family: 'cpu',
    runtime: 'llama.cpp-b9940-cpu',
    requestedDevice: 'CPU',
    launchArgs: ['--gpu-layers', '0'],
  });
  assert.deepEqual(CUDA_RUNTIME, {
    family: 'cuda',
    runtime: 'llama.cpp-b9940-cuda12.4',
    requestedDevice: 'CUDA_AUTO',
    launchArgs: ['--device', 'CUDA0', '--gpu-layers', 'auto', '--fit', 'on'],
  });
});

test('runtime descriptors reject a requested device inconsistent with their family', () => {
  assert.throws(() => new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    runtimeDescriptor: {
      family: 'cuda',
      runtime: 'llama.cpp-custom-cuda',
      requestedDevice: 'CPU',
      launchArgs: ['--device', 'CUDA2', '--gpu-layers', 'auto', '--fit', 'on'],
    },
  }), /requestedDevice/);
});

test('persistent llama.cpp server starts on loopback with explicit CPU runtime', async () => {
  const spawned = [];
  const server = new LlamaTranslationServer({
    binaryPath: 'C:\\runtime\\llama-server.exe',
    modelPath: 'C:\\models\\hy-mt2.gguf',
    runtimeDescriptor: CPU_RUNTIME,
    allocatePort: async () => 23841,
    spawn: (binary, args, options) => {
      spawned.push({ binary, args, options });
      return child();
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });

  await server.start();
  assert.deepEqual(spawned[0], {
    binary: 'C:\\runtime\\llama-server.exe',
    args: [
    '-m', 'C:\\models\\hy-mt2.gguf', '--host', '127.0.0.1',
      '--port', '23841', '--no-webui', '-c', '2048', '--log-colors', 'off',
      '--gpu-layers', '0',
    ],
    options: {
      cwd: 'C:\\runtime',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  });
  assert.deepEqual(server.health(), {
    id: 'hy-mt2-1.8b',
    runtime: 'llama.cpp-b9940-cpu',
    requestedDevice: 'CPU',
    actualDevice: 'CPU',
    deviceName: null,
    offload: 'none',
    fallbackReason: null,
    ready: true,
    loadMs: server.health().loadMs,
  });
});

test('CPU runtime remains the default for current supervisor compatibility', async () => {
  let launchArgs;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    allocatePort: async () => 23842,
    spawn: (_binary, args) => {
      launchArgs = args;
      return child();
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });

  const health = await server.start();
  assert.deepEqual(launchArgs.slice(-2), ['--gpu-layers', '0']);
  assert.equal(health.runtime, CPU_RUNTIME.runtime);
  assert.equal(health.actualDevice, 'CPU');
});

test('a spawn error racing a healthy response keeps the stable failure code', async () => {
  let spawnedChild;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    allocatePort: async () => 23845,
    spawn: () => {
      spawnedChild = child();
      return spawnedChild;
    },
    fetchImpl: async () => {
      spawnedChild.emit('error', new Error('spawn failed late'));
      return { ok: true, status: 200 };
    },
  });

  await assert.rejects(server.start(), { code: 'local_translation_spawn_failed' });
  assert.equal(server.health().ready, false);
  assert.equal(spawnedChild.killCalls.length > 0, true);
});

test('CUDA runtime launches exact device, automatic offload, and fit arguments', async () => {
  let spawned;
  let spawnedChild;
  const server = new LlamaTranslationServer({
    binaryPath: 'C:\\runtime\\cuda\\llama-server.exe',
    modelPath: 'C:\\models\\hy-mt2.gguf',
    runtimeDescriptor: CUDA_RUNTIME,
    maxRestarts: 0,
    allocatePort: async () => 23843,
    spawn: (binary, args, options) => {
      spawnedChild = child();
      spawned = { binary, args, options };
      return spawnedChild;
    },
    fetchImpl: async () => {
      spawnedChild.stderr.emit('data', Buffer.from(
        'ggml_cuda_init: found 1 CUDA devices:\n' +
        '  Device 0: NVIDIA RTX 3000 Ada Generation Laptop GPU\n' +
        'load_tensors: offloaded 29/29 layers to GPU\n',
      ));
      return { ok: true, status: 200 };
    },
  });

  await server.start();
  assert.deepEqual(spawned, {
    binary: 'C:\\runtime\\cuda\\llama-server.exe',
    args: [
      '-m', 'C:\\models\\hy-mt2.gguf', '--host', '127.0.0.1',
      '--port', '23843', '--no-webui', '-c', '2048', '--log-colors', 'off',
      '--device', 'CUDA0', '--gpu-layers', 'auto', '--fit', 'on',
    ],
    options: {
      cwd: 'C:\\runtime\\cuda',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  });
});

test('CUDA full evidence appears in health and translation provenance', async () => {
  let spawnedChild;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    runtimeDescriptor: CUDA_RUNTIME,
    allocatePort: async () => 23844,
    spawn: () => {
      spawnedChild = child();
      return spawnedChild;
    },
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) {
        spawnedChild.stderr.emit('data', Buffer.from('ggml_cuda_init: found 1 CUDA devices:\n'));
        spawnedChild.stderr.emit('data', Buffer.from('  Device 0: NVIDIA RTX 3000 Ada Generation Laptop GPU\n'));
        spawnedChild.stderr.emit('data', Buffer.from('load_tensors: offloaded 29/29 layers to GPU\n'));
        return { ok: true, status: 200 };
      }
      return completion(' 保持 ±0.2 mm。 ');
    },
  });

  const health = await server.start();
  const result = await server.translate('translate.final', {
    utteranceId: 'u-cuda', sourceRevision: 4, sourceLanguage: 'English',
    targetLanguage: 'Chinese', text: 'Hold ±0.2 mm.',
  });
  assert.deepEqual({
    runtime: health.runtime,
    requestedDevice: health.requestedDevice,
    actualDevice: health.actualDevice,
    deviceName: health.deviceName,
    offload: health.offload,
    fallbackReason: health.fallbackReason,
  }, {
    runtime: 'llama.cpp-b9940-cuda12.4',
    requestedDevice: 'CUDA_AUTO',
    actualDevice: 'CUDA0',
    deviceName: 'NVIDIA RTX 3000 Ada Generation Laptop GPU',
    offload: 'full',
    fallbackReason: null,
  });
  assert.deepEqual({
    runtime: result.runtime,
    requestedDevice: result.requestedDevice,
    actualDevice: result.actualDevice,
    deviceName: result.deviceName,
    offload: result.offload,
    fallbackReason: result.fallbackReason,
  }, {
    runtime: health.runtime,
    requestedDevice: health.requestedDevice,
    actualDevice: health.actualDevice,
    deviceName: health.deviceName,
    offload: health.offload,
    fallbackReason: null,
  });
});

for (const [label, log, expected] of [
  ['partial', 'CUDA0: NVIDIA RTX 4090\nload_tensors: offloaded 12/29 layers to GPU\n', 'partial'],
  ['unknown without layer counts', 'CUDA0: NVIDIA RTX 4090\n', 'unknown'],
  ['none for zero layers', 'CUDA0: NVIDIA RTX 4090\nload_tensors: offloaded 0/29 layers to GPU\n', 'none'],
]) {
  test(`CUDA evidence reports ${label}`, async () => {
    let spawnedChild;
    const server = new LlamaTranslationServer({
      binaryPath: 'llama-server.exe',
      modelPath: 'hy-mt2.gguf',
      runtimeDescriptor: CUDA_RUNTIME,
      maxRestarts: 0,
      allocatePort: async () => 24000,
      spawn: () => {
        spawnedChild = child();
        return spawnedChild;
      },
      fetchImpl: async () => {
        spawnedChild.stderr.emit('data', Buffer.from(log));
        return { ok: true, status: 200 };
      },
    });

    assert.equal((await server.start()).offload, expected);
  });
}

for (const [label, log] of [
  ['missing', 'load_tensors: offloaded 29/29 layers to GPU\n'],
  ['non-NVIDIA', 'CUDA0: AMD Radeon 780M\nload_tensors: offloaded 29/29 layers to GPU\n'],
  ['mismatched', 'CUDA1: NVIDIA RTX 4090\nload_tensors: offloaded 29/29 layers to GPU\n'],
]) {
  test(`CUDA startup rejects ${label} selected-device evidence`, async () => {
    let spawnedChild;
    const server = new LlamaTranslationServer({
      binaryPath: 'llama-server.exe',
      modelPath: 'hy-mt2.gguf',
      runtimeDescriptor: CUDA_RUNTIME,
      maxRestarts: 0,
      shutdownTimeoutMs: 10,
      allocatePort: async () => 24001,
      spawn: () => {
        spawnedChild = child();
        return spawnedChild;
      },
      fetchImpl: async () => {
        spawnedChild.stderr.emit('data', Buffer.from(log));
        return { ok: true, status: 200 };
      },
    });

    await assert.rejects(server.start(), { code: 'local_translation_device_unverified' });
    assert.equal(spawnedChild.killCalls.length > 0, true);
    assert.equal(server.health().ready, false);
  });
}

test('CUDA evidence survives split chunks and stderr rolling-buffer eviction', async () => {
  let spawnedChild;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    runtimeDescriptor: CUDA_RUNTIME,
    allocatePort: async () => 24002,
    spawn: () => {
      spawnedChild = child();
      return spawnedChild;
    },
    fetchImpl: async () => {
      spawnedChild.stderr.emit('data', Buffer.from('CUDA0: NVIDIA RTX 3000 Ada Gener'));
      spawnedChild.stderr.emit('data', Buffer.from('ation Laptop GPU\n'));
      spawnedChild.stderr.emit('data', Buffer.from(`${'later stderr '.repeat(800)}\n`));
      spawnedChild.stderr.emit('data', Buffer.from('load_tensors: offloaded 12/29 layers to GPU\n'));
      return { ok: true, status: 200 };
    },
  });

  const health = await server.start();
  assert.equal(server.stderr.length <= 8_000, true);
  assert.equal(health.deviceName, 'NVIDIA RTX 3000 Ada Generation Laptop GPU');
  assert.equal(health.offload, 'partial');
});

test('caller descriptor and returned provenance mutations cannot alter server state', async () => {
  const descriptor = {
    family: 'cuda',
    runtime: 'llama.cpp-custom-cuda',
    requestedDevice: 'CUDA_AUTO',
    launchArgs: ['--device', 'CUDA2', '--gpu-layers', 'auto', '--fit', 'on'],
  };
  let launchArgs;
  let spawnedChild;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    runtimeDescriptor: descriptor,
    allocatePort: async () => 24003,
    spawn: (_binary, args) => {
      launchArgs = args;
      spawnedChild = child();
      return spawnedChild;
    },
    fetchImpl: async (url) => {
      if (url.endsWith('/health')) {
        spawnedChild.stderr.emit('data', Buffer.from('CUDA2: NVIDIA RTX 6000 Ada\n'));
        return { ok: true, status: 200 };
      }
      return completion();
    },
  });
  descriptor.runtime = 'mutated';
  descriptor.launchArgs[1] = 'CUDA9';

  const health = await server.start();
  assert.equal(launchArgs.includes('CUDA2'), true);
  assert.equal(health.runtime, 'llama.cpp-custom-cuda');
  health.runtime = 'mutated health';
  health.deviceName = 'mutated name';
  assert.equal(server.health().runtime, 'llama.cpp-custom-cuda');
  assert.equal(server.health().deviceName, 'NVIDIA RTX 6000 Ada');

  const first = await server.translate('translate.final', { targetLanguage: 'Chinese', text: 'first' });
  first.runtime = 'mutated result';
  first.deviceName = 'mutated result name';
  const second = await server.translate('translate.final', { targetLanguage: 'Chinese', text: 'second' });
  assert.equal(second.runtime, 'llama.cpp-custom-cuda');
  assert.equal(second.deviceName, 'NVIDIA RTX 6000 Ada');
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
  assert.equal(result.runtime, 'llama.cpp-b9940-cpu');
  assert.equal(result.requestedDevice, 'CPU');
  assert.equal(result.actualDevice, 'CPU');
  assert.equal(result.deviceName, null);
  assert.equal(result.offload, 'none');
  assert.equal(result.fallbackReason, null);
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

test('stop waits for normal close and removes owned listeners', async () => {
  let spawnedChild;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    allocatePort: async () => 25001,
    spawn: () => {
      spawnedChild = child({
        onKill: (process) => {
          process.exitCode = 0;
          process.emit('close', 0);
        },
      });
      return spawnedChild;
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  await server.start();

  await server.stop();
  assert.deepEqual(spawnedChild.killCalls, [undefined]);
  assert.equal(spawnedChild.listenerCount('close'), 0);
  assert.equal(spawnedChild.listenerCount('error'), 0);
  assert.equal(spawnedChild.stderr.listenerCount('data'), 0);
  assert.equal(server.port, 0);
  assert.equal(server.health().ready, false);
});

test('stop force-kills after its deadline and settles without close', async () => {
  let spawnedChild;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    shutdownTimeoutMs: 10,
    allocatePort: async () => 25002,
    spawn: () => {
      spawnedChild = child({
        onKill: (process, signal) => {
          if (signal === 'SIGKILL') process.exitCode = 137;
        },
      });
      return spawnedChild;
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  await server.start();

  const startedAt = Date.now();
  await server.stop();
  assert.equal(Date.now() - startedAt < 500, true);
  assert.deepEqual(spawnedChild.killCalls, [undefined, 'SIGKILL']);
  assert.equal(spawnedChild.listenerCount('close'), 0);
  assert.equal(spawnedChild.listenerCount('error'), 0);
  assert.equal(spawnedChild.stderr.listenerCount('data'), 0);
});

test('stop handles an already-exited child immediately', async () => {
  let spawnedChild;
  const server = new LlamaTranslationServer({
    binaryPath: 'llama-server.exe',
    modelPath: 'hy-mt2.gguf',
    shutdownTimeoutMs: 100,
    allocatePort: async () => 25003,
    spawn: () => {
      spawnedChild = child();
      return spawnedChild;
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  await server.start();
  spawnedChild.exitCode = 0;

  const startedAt = Date.now();
  await server.stop();
  assert.equal(Date.now() - startedAt < 50, true);
  assert.deepEqual(spawnedChild.killCalls, []);
  assert.equal(spawnedChild.listenerCount('close'), 0);
  assert.equal(spawnedChild.stderr.listenerCount('data'), 0);
});
