const assert = require('node:assert/strict');
const test = require('node:test');

const { HyMt2RuntimeController } = require('./hy-mt2-runtime-controller');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function runtimeError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function server(family, { start, translate, stop } = {}) {
  const calls = { start: 0, translate: [], stop: 0 };
  const provenance = family === 'cuda'
    ? {
        id: 'hy-mt2-1.8b', ready: true,
        runtime: 'llama.cpp-b9940-cuda12.4', requestedDevice: 'CUDA_AUTO',
        actualDevice: 'CUDA0', deviceName: 'NVIDIA RTX 3000 Ada',
        offload: 'full', fallbackReason: null, loadMs: 12,
      }
    : {
        id: 'hy-mt2-1.8b', ready: true,
        runtime: 'llama.cpp-b9940-cpu', requestedDevice: 'CPU',
        actualDevice: 'CPU', deviceName: null,
        offload: 'none', fallbackReason: null, loadMs: 34,
      };
  return {
    calls,
    async start() {
      calls.start += 1;
      return start ? start(calls.start) : { ...provenance };
    },
    health() {
      return { ...provenance };
    },
    async translate(type, payload, options) {
      calls.translate.push({ type, payload, options });
      if (translate) return translate(type, payload, options, calls.translate.length);
      return {
        protocolVersion: 1,
        type: 'translate.result',
        utteranceId: payload.utteranceId,
        sourceRevision: payload.sourceRevision,
        text: `${family} translation`,
        authoritative: type === 'translate.final',
        ...provenance,
      };
    },
    async stop() {
      calls.stop += 1;
      return stop?.(calls.stop);
    },
  };
}

function probe(...results) {
  const calls = { probe: 0, invalidate: 0 };
  return {
    calls,
    async probe() {
      const index = calls.probe++;
      const value = results[Math.min(index, results.length - 1)];
      return typeof value === 'function' ? value() : value;
    },
    invalidate() {
      calls.invalidate += 1;
    },
  };
}

const usable = {
  usable: true,
  requestedDevice: 'CUDA_AUTO',
  actualDevice: 'CUDA0',
  deviceName: 'NVIDIA RTX 3000 Ada',
  fallbackReason: null,
};

function unavailable(fallbackReason) {
  return {
    usable: false,
    requestedDevice: 'CUDA_AUTO',
    actualDevice: null,
    deviceName: null,
    fallbackReason,
  };
}

async function startedController({ enabled = true, probeImpl, cudaServer, cpuServer } = {}) {
  const controller = new HyMt2RuntimeController({
    enabled,
    probe: probeImpl || probe(usable),
    cudaServer: cudaServer || server('cuda'),
    cpuServer: cpuServer || server('cpu'),
  });
  await controller.beginSession('session-1');
  await controller.start();
  return controller;
}

test('feature flag off starts CPU directly and never probes CUDA', async () => {
  const cudaProbe = probe(usable);
  const cuda = server('cuda');
  const cpu = server('cpu');
  const statuses = [];
  const controller = new HyMt2RuntimeController({
    enabled: false, probe: cudaProbe, cudaServer: cuda, cpuServer: cpu,
  });
  controller.on('status', value => statuses.push(value));

  await controller.beginSession('off');
  const health = await controller.start();

  assert.equal(cudaProbe.calls.probe, 0);
  assert.equal(cuda.calls.start, 0);
  assert.equal(cpu.calls.start, 1);
  assert.equal(health.requestedDevice, 'CPU');
  assert.equal(health.actualDevice, 'CPU');
  assert.equal(health.fallbackReason, null);
  assert.deepEqual(statuses, [health]);
});

test('usable CUDA starts the CUDA server without starting CPU', async () => {
  const cudaProbe = probe(usable);
  const cuda = server('cuda');
  const cpu = server('cpu');
  const controller = await startedController({ probeImpl: cudaProbe, cudaServer: cuda, cpuServer: cpu });

  assert.equal(cudaProbe.calls.probe, 1);
  assert.equal(cuda.calls.start, 1);
  assert.equal(cpu.calls.start, 0);
  assert.equal(controller.health().actualDevice, 'CUDA0');
  assert.equal(controller.health().fallbackReason, null);
});

for (const reason of [
  'cuda_device_unavailable',
  'cuda_probe_spawn_failed',
  'cuda_probe_timeout',
]) {
  test(`probe fallback preserves exact ${reason} code on CPU`, async () => {
    const cudaProbe = probe(unavailable(reason));
    const cuda = server('cuda');
    const cpu = server('cpu');
    const controller = await startedController({ probeImpl: cudaProbe, cudaServer: cuda, cpuServer: cpu });

    assert.equal(cuda.calls.start, 0);
    assert.equal(cpu.calls.start, 1);
    assert.equal(controller.health().requestedDevice, 'CUDA_AUTO');
    assert.equal(controller.health().actualDevice, 'CPU');
    assert.equal(controller.health().fallbackReason, reason);
  });
}

for (const code of ['local_translation_spawn_failed', 'local_translation_device_unverified']) {
  test(`CUDA ${code} stops CUDA before CPU startup`, async () => {
    const order = [];
    const cudaProbe = probe(usable);
    const cuda = server('cuda', {
      start: async () => {
        order.push('cuda start');
        throw runtimeError(code);
      },
      stop: async () => { order.push('cuda stop'); },
    });
    const cpu = server('cpu', { start: async () => { order.push('cpu start'); } });
    const controller = await startedController({ probeImpl: cudaProbe, cudaServer: cuda, cpuServer: cpu });

    assert.deepEqual(order, ['cuda start', 'cuda stop', 'cpu start']);
    assert.equal(cudaProbe.calls.invalidate, 1);
    assert.equal(controller.health().fallbackReason, code);
  });
}

test('CUDA crash increments generation, invalidates probe, falls back once, and retries a final unchanged', async () => {
  const crash = runtimeError('local_translation_host_closed');
  const cudaProbe = probe(usable);
  const cuda = server('cuda', { translate: async () => { throw crash; } });
  const cpu = server('cpu');
  const controller = await startedController({ probeImpl: cudaProbe, cudaServer: cuda, cpuServer: cpu });
  const initialGeneration = controller.generation;
  const payload = {
    utteranceId: 'utterance-7', sourceRevision: 9, text: 'Keep ±0.2 mm.',
    glossary: [{ en: 'fixture', zh: '夹具' }], protectedTokens: ['±0.2 mm'],
  };
  const abort = new AbortController();
  const options = { signal: abort.signal };

  const result = await controller.translate('translate.final', payload, options);

  assert.equal(controller.generation, initialGeneration + 1);
  assert.equal(cudaProbe.calls.invalidate, 1);
  assert.equal(cuda.calls.stop, 1);
  assert.equal(cpu.calls.start, 1);
  assert.equal(cpu.calls.translate.length, 1);
  assert.equal(cpu.calls.translate[0].payload, payload);
  assert.equal(cpu.calls.translate[0].options, options);
  assert.equal(result.authoritative, true);
  assert.equal(result.requestedDevice, 'CUDA_AUTO');
  assert.equal(result.actualDevice, 'CPU');
  assert.equal(result.fallbackReason, 'local_translation_host_closed');
});

test('preview from a retired CUDA generation rejects AbortError and is not retried', async () => {
  const cuda = server('cuda', {
    translate: async () => { throw runtimeError('local_translation_host_closed'); },
  });
  const cpu = server('cpu');
  const controller = await startedController({ cudaServer: cuda, cpuServer: cpu });

  await assert.rejects(
    controller.translate('translate.preview', { utteranceId: 'preview-1' }),
    { name: 'AbortError', code: 'ABORT_ERR' },
  );
  assert.equal(cpu.calls.start, 1);
  assert.equal(cpu.calls.translate.length, 0);
});

test('late CUDA response is rejected after another request retires its generation', async () => {
  const late = deferred();
  const cuda = server('cuda', {
    translate: async (_type, _payload, _options, call) => {
      if (call === 1) return late.promise;
      throw runtimeError('local_translation_host_closed');
    },
  });
  const cpu = server('cpu');
  const controller = await startedController({ cudaServer: cuda, cpuServer: cpu });

  const lateRequest = controller.translate('translate.final', { utteranceId: 'late', sourceRevision: 1 });
  const fallbackRequest = controller.translate('translate.final', { utteranceId: 'crash', sourceRevision: 1 });
  await fallbackRequest;
  late.resolve({
    utteranceId: 'late', sourceRevision: 1, text: 'stale CUDA', authoritative: true,
    ...cuda.health(),
  });

  await assert.rejects(lateRequest, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(cpu.calls.translate.length, 1);
});

test('an old-session CUDA rejection cannot retire or retry on a healthy new session', async () => {
  const oldRequest = deferred();
  const cudaProbe = probe(usable, usable);
  const cuda = server('cuda', {
    translate: async (_type, _payload, _options, call) => {
      if (call === 1) return oldRequest.promise;
      return { text: 'new session', authoritative: true, ...cuda.health() };
    },
  });
  const cpu = server('cpu');
  const controller = await startedController({ probeImpl: cudaProbe, cudaServer: cuda, cpuServer: cpu });
  const staleTranslation = controller.translate('translate.final', {
    utteranceId: 'old-session', sourceRevision: 1,
  });

  await controller.beginSession('session-2');
  await controller.start();
  oldRequest.reject(runtimeError('local_translation_host_closed'));

  await assert.rejects(staleTranslation, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(controller.health().actualDevice, 'CUDA0');
  assert.equal(controller.health().fallbackReason, null);
  assert.equal(cudaProbe.calls.invalidate, 0);
  assert.equal(cpu.calls.start, 0);
  assert.equal(cpu.calls.translate.length, 0);
});

test('concurrent failed finals share one fallback and each retry once', async () => {
  const bothFailed = deferred();
  const cuda = server('cuda', {
    translate: async () => {
      await bothFailed.promise;
      throw runtimeError('local_translation_host_closed');
    },
  });
  const cpu = server('cpu');
  const controller = await startedController({ cudaServer: cuda, cpuServer: cpu });

  const first = controller.translate('translate.final', { utteranceId: 'a' });
  const second = controller.translate('translate.final', { utteranceId: 'b' });
  bothFailed.resolve();
  const results = await Promise.all([first, second]);

  assert.equal(cuda.calls.stop, 1);
  assert.equal(cpu.calls.start, 1);
  assert.equal(cpu.calls.translate.length, 2);
  assert.deepEqual(results.map(result => result.text), ['cpu translation', 'cpu translation']);
});

test('a delayed failure from the just-retired CUDA generation reschedules its final on active CPU', async () => {
  const delayedFailure = deferred();
  const cuda = server('cuda', {
    translate: async (_type, _payload, _options, call) => {
      if (call === 1) throw runtimeError('local_translation_host_closed');
      return delayedFailure.promise;
    },
  });
  const cpu = server('cpu');
  const controller = await startedController({ cudaServer: cuda, cpuServer: cpu });

  const first = controller.translate('translate.final', { utteranceId: 'first-final' });
  const delayed = controller.translate('translate.final', { utteranceId: 'delayed-final' });
  const firstResult = await first;
  assert.equal(cpu.calls.translate.length, 1);
  delayedFailure.reject(runtimeError('local_translation_host_closed'));
  const delayedResult = await delayed;

  assert.equal(cuda.calls.stop, 1);
  assert.equal(cpu.calls.start, 1);
  assert.equal(cpu.calls.translate.length, 2);
  assert.equal(firstResult.authoritative, true);
  assert.equal(delayedResult.authoritative, true);
  assert.equal(delayedResult.requestedDevice, 'CUDA_AUTO');
  assert.equal(delayedResult.actualDevice, 'CPU');
  assert.equal(delayedResult.fallbackReason, 'local_translation_host_closed');
});

test('a delayed preview failure from the retired CUDA generation stays cancelled', async () => {
  const delayedFailure = deferred();
  const cuda = server('cuda', {
    translate: async (type) => {
      if (type === 'translate.final') throw runtimeError('local_translation_host_closed');
      return delayedFailure.promise;
    },
  });
  const cpu = server('cpu');
  const controller = await startedController({ cudaServer: cuda, cpuServer: cpu });

  const preview = controller.translate('translate.preview', { utteranceId: 'delayed-preview' });
  await controller.translate('translate.final', { utteranceId: 'fallback-final' });
  delayedFailure.reject(runtimeError('local_translation_host_closed'));

  await assert.rejects(preview, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(cpu.calls.translate.length, 1);
});

test('start and translation arriving during fallback wait for retired CUDA to stop', async () => {
  const stopped = deferred();
  const cuda = server('cuda', {
    translate: async () => { throw runtimeError('local_translation_host_closed'); },
    stop: async () => stopped.promise,
  });
  const cpu = server('cpu');
  const controller = await startedController({ cudaServer: cuda, cpuServer: cpu });

  const failedFinal = controller.translate('translate.final', { utteranceId: 'failure' });
  await new Promise(resolve => setImmediate(resolve));
  const joiningStart = controller.start();
  const joiningTranslation = controller.translate('translate.final', { utteranceId: 'joining' });
  await new Promise(resolve => setImmediate(resolve));
  const cpuStartsBeforeCudaStopped = cpu.calls.start;
  stopped.resolve();
  const [retriedResult, joinedHealth, joinedResult] = await Promise.all([
    failedFinal, joiningStart, joiningTranslation,
  ]);

  assert.equal(cpuStartsBeforeCudaStopped, 0);
  assert.equal(cuda.calls.stop, 1);
  assert.equal(cpu.calls.start, 1);
  assert.equal(cpu.calls.translate.length, 2);
  assert.equal(joinedHealth.actualDevice, 'CPU');
  assert.equal(retriedResult.fallbackReason, 'local_translation_host_closed');
  assert.equal(joinedResult.fallbackReason, 'local_translation_host_closed');
});

test('caller AbortError with a transport-like code never triggers CUDA fallback', async () => {
  const cancellation = runtimeError('ECONNRESET', 'cancelled by caller');
  cancellation.name = 'AbortError';
  const cudaProbe = probe(usable);
  const cuda = server('cuda', { translate: async () => { throw cancellation; } });
  const cpu = server('cpu');
  const controller = await startedController({ probeImpl: cudaProbe, cudaServer: cuda, cpuServer: cpu });

  await assert.rejects(
    controller.translate('translate.final', { utteranceId: 'cancelled' }),
    error => error === cancellation,
  );
  assert.equal(cudaProbe.calls.invalidate, 0);
  assert.equal(cuda.calls.stop, 0);
  assert.equal(cpu.calls.start, 0);
});

test('an already-aborted caller signal suppresses fallback for a transport failure', async () => {
  const failure = runtimeError('ECONNRESET');
  const caller = new AbortController();
  caller.abort();
  const cudaProbe = probe(usable);
  const cuda = server('cuda', { translate: async () => { throw failure; } });
  const cpu = server('cpu');
  const controller = await startedController({ probeImpl: cudaProbe, cudaServer: cuda, cpuServer: cpu });

  await assert.rejects(
    controller.translate('translate.final', { utteranceId: 'already-aborted' }, { signal: caller.signal }),
    error => error === failure,
  );
  assert.equal(cudaProbe.calls.invalidate, 0);
  assert.equal(cpu.calls.start, 0);
});

test('a bounded nested transport cause retires CUDA and retries a final on CPU', async () => {
  const failure = new TypeError('fetch failed', {
    cause: runtimeError('ECONNRESET', 'socket closed'),
  });
  const cuda = server('cuda', { translate: async () => { throw failure; } });
  const cpu = server('cpu');
  const controller = await startedController({ cudaServer: cuda, cpuServer: cpu });

  const result = await controller.translate('translate.final', { utteranceId: 'nested-cause' });

  assert.equal(cpu.calls.start, 1);
  assert.equal(cpu.calls.translate.length, 1);
  assert.equal(result.fallbackReason, 'local_translation_host_closed');
});

for (const semanticCode of [
  'local_translation_failed',
  'local_translation_timeout',
  'local_translation_invalid_result',
]) {
  test(`${semanticCode} is not overridden by a nested transport cause`, async () => {
    const semanticError = runtimeError(semanticCode);
    semanticError.cause = runtimeError('ECONNRESET');
    const cudaProbe = probe(usable);
    const cuda = server('cuda', { translate: async () => { throw semanticError; } });
    const cpu = server('cpu');
    const controller = await startedController({
      probeImpl: cudaProbe, cudaServer: cuda, cpuServer: cpu,
    });

    await assert.rejects(
      controller.translate('translate.final', { utteranceId: semanticCode }),
      error => error === semanticError,
    );
    assert.equal(cudaProbe.calls.invalidate, 0);
    assert.equal(cuda.calls.stop, 0);
    assert.equal(cpu.calls.start, 0);
  });
}

test('CPU failure after CUDA failure preserves the local error contract and adds fallback metadata', async () => {
  const cpuError = runtimeError('local_translation_failed', 'llama.cpp returned HTTP 500');
  const cuda = server('cuda', {
    translate: async () => { throw runtimeError('local_translation_host_closed'); },
  });
  const cpu = server('cpu', { translate: async () => { throw cpuError; } });
  const controller = await startedController({ cudaServer: cuda, cpuServer: cpu });

  await assert.rejects(
    controller.translate('translate.final', { utteranceId: 'both-fail' }),
    error => {
      assert.equal(error, cpuError);
      assert.equal(error.code, 'local_translation_failed');
      assert.equal(error.fallbackReason, 'local_translation_host_closed');
      return true;
    },
  );
});

test('a CPU retry failure after its session is replaced rejects as stale', async () => {
  const cpuRetry = deferred();
  const cuda = server('cuda', {
    translate: async () => { throw runtimeError('local_translation_host_closed'); },
  });
  const cpu = server('cpu', { translate: async () => cpuRetry.promise });
  const controller = await startedController({ cudaServer: cuda, cpuServer: cpu });
  const staleRetry = controller.translate('translate.final', { utteranceId: 'stale-retry' });
  while (cpu.calls.translate.length === 0) {
    await new Promise(resolve => setImmediate(resolve));
  }

  await controller.beginSession('session-2');
  await controller.start();
  cpuRetry.reject(runtimeError('local_translation_failed'));

  await assert.rejects(staleRetry, { name: 'AbortError', code: 'ABORT_ERR' });
});

test('CUDA retirement is stable within a session but a new session may probe CUDA again', async () => {
  const cudaProbe = probe(usable, usable);
  const cuda = server('cuda', {
    translate: async (_type, _payload, _options, call) => {
      if (call === 1) throw runtimeError('local_translation_host_closed');
      return { text: 'new-session CUDA', authoritative: true, ...cuda.health() };
    },
  });
  const cpu = server('cpu');
  const controller = await startedController({ probeImpl: cudaProbe, cudaServer: cuda, cpuServer: cpu });
  await controller.translate('translate.final', { utteranceId: 'retire' });

  await controller.stop();
  await controller.start();
  assert.equal(cudaProbe.calls.probe, 1);
  assert.equal(cuda.calls.start, 1);
  assert.equal(cpu.calls.start, 2);

  await controller.beginSession('session-2');
  await controller.start();
  assert.equal(cudaProbe.calls.probe, 2);
  assert.equal(cuda.calls.start, 2);
  assert.equal(controller.health().actualDevice, 'CUDA0');
});

test('status events contain only sanitized runtime provenance after selection and fallback', async () => {
  const cuda = server('cuda', {
    translate: async () => { throw runtimeError('local_translation_host_closed', 'secret C:\\runtime stderr'); },
  });
  const cpu = server('cpu');
  const controller = new HyMt2RuntimeController({
    enabled: true, probe: probe(usable), cudaServer: cuda, cpuServer: cpu,
  });
  const statuses = [];
  controller.on('status', status => statuses.push(status));
  await controller.beginSession('status');
  await controller.start();
  await controller.translate('translate.final', { utteranceId: 'status-final' });

  assert.equal(statuses.length, 2);
  assert.deepEqual(Object.keys(statuses[1]).sort(), [
    'actualDevice', 'deviceName', 'fallbackReason', 'id', 'loadMs',
    'offload', 'ready', 'requestedDevice', 'runtime',
  ]);
  assert.equal(JSON.stringify(statuses).includes('secret'), false);
  assert.equal(statuses[1].fallbackReason, 'local_translation_host_closed');
});

test('CPU startup failure keeps its error code and attaches the attempted CUDA reason', async () => {
  const failure = runtimeError('local_translation_spawn_failed', 'CPU runtime missing');
  const cpu = server('cpu', { start: async () => { throw failure; } });
  const controller = new HyMt2RuntimeController({
    enabled: true,
    probe: probe(unavailable('cuda_probe_exit_failed')),
    cudaServer: server('cuda'),
    cpuServer: cpu,
  });
  await controller.beginSession('cpu-start-failure');

  await assert.rejects(controller.start(), error => {
    assert.equal(error, failure);
    assert.equal(error.code, 'local_translation_spawn_failed');
    assert.equal(error.fallbackReason, 'cuda_probe_exit_failed');
    return true;
  });
});

for (const [label, optionalDependencies] of [
  ['probe', { probe: null, cudaServer: server('cuda') }],
  ['CUDA server', { probe: probe(usable), cudaServer: null }],
]) {
  test(`enabled acceleration with no ${label} starts CPU as CUDA unavailable`, async () => {
    const cpu = server('cpu');
    const controller = new HyMt2RuntimeController({
      enabled: true,
      probe: optionalDependencies.probe,
      cudaServer: optionalDependencies.cudaServer,
      cpuServer: cpu,
    });
    await controller.beginSession(`missing-${label}`);

    const health = await controller.start();

    assert.equal(cpu.calls.start, 1);
    assert.equal(health.requestedDevice, 'CUDA_AUTO');
    assert.equal(health.actualDevice, 'CPU');
    assert.equal(health.fallbackReason, 'cuda_device_unavailable');
  });
}

test('beginSession during an old probe prevents the stale session from starting a server', async () => {
  const oldProbe = deferred();
  const cudaProbe = probe(() => oldProbe.promise, usable);
  const cuda = server('cuda');
  const cpu = server('cpu');
  const controller = new HyMt2RuntimeController({
    enabled: true, probe: cudaProbe, cudaServer: cuda, cpuServer: cpu,
  });
  await controller.beginSession('old');
  const staleStart = controller.start();
  await controller.beginSession('new');
  oldProbe.resolve(usable);

  await assert.rejects(staleStart, { name: 'AbortError', code: 'ABORT_ERR' });
  await controller.start();
  assert.equal(cuda.calls.start, 1);
  assert.equal(cpu.calls.start, 0);
});

test('a second session change invalidates a start queued behind the same stop', async () => {
  const cuda = server('cuda');
  const controller = new HyMt2RuntimeController({
    enabled: true, probe: probe(usable), cudaServer: cuda, cpuServer: server('cpu'),
  });

  const firstSession = controller.beginSession('first');
  const staleStart = controller.start();
  const secondSession = controller.beginSession('second');
  await Promise.all([firstSession, secondSession]);

  await assert.rejects(staleStart, { name: 'AbortError', code: 'ABORT_ERR' });
  await controller.start();
  assert.equal(cuda.calls.start, 1);
});

test('stop during CUDA startup cancels stale selection and a subsequent start is clean', async () => {
  const pendingStart = deferred();
  const cuda = server('cuda', {
    start: async call => call === 1 ? pendingStart.promise : cuda.health(),
  });
  const controller = new HyMt2RuntimeController({
    enabled: true, probe: probe(usable), cudaServer: cuda, cpuServer: server('cpu'),
  });
  await controller.beginSession('overlap');
  const staleStart = controller.start();
  await new Promise(resolve => setImmediate(resolve));
  const stopping = controller.stop();
  pendingStart.reject(runtimeError('local_translation_start_cancelled'));

  await stopping;
  await assert.rejects(staleStart, { name: 'AbortError', code: 'ABORT_ERR' });
  await controller.start();
  assert.equal(cuda.calls.start, 2);
  assert.equal(controller.health().actualDevice, 'CUDA0');
});

test('stop during fallback waits for retired CUDA and prevents CPU startup', async () => {
  const stopped = deferred();
  const cuda = server('cuda', {
    translate: async () => { throw runtimeError('local_translation_host_closed'); },
    stop: async () => stopped.promise,
  });
  const cpu = server('cpu');
  const controller = await startedController({ cudaServer: cuda, cpuServer: cpu });
  const failedFinal = controller.translate('translate.final', { utteranceId: 'stop-fallback' });
  await new Promise(resolve => setImmediate(resolve));

  let stopSettled = false;
  const stopping = controller.stop().then(() => { stopSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforeCudaStop = stopSettled;
  stopped.resolve();
  await stopping;

  await assert.rejects(failedFinal, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(settledBeforeCudaStop, false);
  assert.equal(cpu.calls.start, 0);
});
