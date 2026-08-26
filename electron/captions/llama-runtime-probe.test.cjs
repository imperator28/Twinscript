const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const { LlamaCudaProbe, parseCudaDevices } = require('./llama-runtime-probe');

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function createSpawn(...children) {
  const calls = [];
  return {
    calls,
    spawn(binaryPath, args, options) {
      calls.push({ binaryPath, args, options });
      return children.shift();
    },
  };
}

function closeSuccess(child, output = 'CUDA0: NVIDIA RTX 3000 Ada Generation Laptop GPU') {
  child.stdout.emit('data', Buffer.from(output));
  child.emit('close', 0, null);
}

test('parseCudaDevices normalizes NVIDIA CUDA rows, bounds names, and ignores non-NVIDIA or non-CUDA rows', () => {
  const longName = `NVIDIA ${'X'.repeat(200)}`;
  assert.deepEqual(parseCudaDevices([
    'cpu: system processor',
    'CUDA10: NVIDIA A10',
    'cuda2: NVIDIA RTX 3000 Ada Generation Laptop GPU',
    'CUDA3: AMD Radeon',
    'Vulkan0: NVIDIA not CUDA',
    `CUDA1: ${longName}`,
    'CUDA: NVIDIA malformed',
  ].join('\n')), [
    { actualDevice: 'CUDA10', deviceName: 'NVIDIA A10' },
    { actualDevice: 'CUDA2', deviceName: 'NVIDIA RTX 3000 Ada Generation Laptop GPU' },
    { actualDevice: 'CUDA1', deviceName: longName.slice(0, 160) },
  ]);
});

test('probe invokes packaged CUDA binary and resolves its NVIDIA device', async () => {
  const child = createChild();
  const fake = createSpawn(child);
  const binaryPath = 'C:\\runtime\\cuda\\llama-server.exe';
  const probe = new LlamaCudaProbe({ binaryPath, spawn: fake.spawn });

  const resultPromise = probe.probe();
  closeSuccess(child, 'CUDA10: NVIDIA A10\nCUDA2: NVIDIA RTX 3000 Ada Generation Laptop GPU');

  assert.deepEqual(await resultPromise, {
    usable: true,
    requestedDevice: 'CUDA_AUTO',
    actualDevice: 'CUDA2',
    deviceName: 'NVIDIA RTX 3000 Ada Generation Laptop GPU',
    fallbackReason: null,
  });
  assert.deepEqual(fake.calls, [{
    binaryPath,
    args: ['--list-devices'],
    options: {
      cwd: path.dirname(binaryPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  }]);
  assertNoProbeListeners(child);
});

test('probe uses the Node child-process spawn default when none is injected', async () => {
  const probe = new LlamaCudaProbe({ binaryPath: process.execPath, timeoutMs: 1_000 });
  assert.deepEqual(await probe.probe(), unavailable('cuda_probe_exit_failed'));
});

test('probe freezes successful cached evidence against later mutation', async () => {
  const child = createChild();
  const fake = createSpawn(child);
  const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn });
  const firstPromise = probe.probe();
  closeSuccess(child, 'CUDA0: NVIDIA Immutable');
  const first = await firstPromise;
  assert.equal(Object.isFrozen(first), true);
  first.deviceName = 'mutated';

  const later = await probe.probe();
  assert.equal(later.deviceName, 'NVIDIA Immutable');
  assert.equal(Object.isFrozen(later), true);
  assert.equal(fake.calls.length, 1);
});

test('probe returns cuda_device_unavailable for CPU-only or empty device lists', async () => {
  for (const output of ['CPU: Intel Core', '']) {
    const child = createChild();
    const fake = createSpawn(child);
    const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn });
    const resultPromise = probe.probe();
    closeSuccess(child, output);
    assert.deepEqual(await resultPromise, unavailable('cuda_device_unavailable'));
  }
});

test('probe returns cuda_device_unavailable for non-NVIDIA CUDA devices', async () => {
  const child = createChild();
  const fake = createSpawn(child);
  const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn });
  const resultPromise = probe.probe();
  closeSuccess(child, 'CUDA0: AMD Radeon');
  assert.deepEqual(await resultPromise, unavailable('cuda_device_unavailable'));
});

test('probe returns cuda_probe_spawn_failed after a spawn error', async () => {
  const child = createChild();
  const fake = createSpawn(child);
  const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn });
  const resultPromise = probe.probe();
  child.emit('error', new Error('ENOENT'));
  const result = await resultPromise;
  assert.deepEqual(result, unavailable('cuda_probe_spawn_failed'));
  assert.equal(Object.isFrozen(result), true);
});

test('probe returns cuda_probe_exit_failed on nonzero or signaled exit', async () => {
  for (const [code, signal] of [[1, null], [null, 'SIGTERM']]) {
    const child = createChild();
    const fake = createSpawn(child);
    const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn });
    const resultPromise = probe.probe();
    child.emit('close', code, signal);
    assert.deepEqual(await resultPromise, unavailable('cuda_probe_exit_failed'));
  }
});

test('probe kills and returns an oversized-output failure even with a valid prefix', async () => {
  const child = createChild();
  const fake = createSpawn(child);
  const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn });
  const resultPromise = probe.probe();
  child.stdout.emit('data', Buffer.from(`CUDA0: NVIDIA RTX\n${'x'.repeat(8 * 1024)}`));
  assert.equal(child.killed, false);
  child.stderr.emit('data', Buffer.from('x'.repeat(8 * 1024)));
  assert.equal(child.killed, true);
  assert.deepEqual(await resultPromise, unavailable('cuda_probe_output_overflow'));
});

test('probe kills before resolving cuda_probe_timeout', async () => {
  const child = createChild();
  child.kill = () => {
    child.killed = true;
    child.emit('error', new Error('kill raced with process error'));
    return true;
  };
  const fake = createSpawn(child);
  const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn, timeoutMs: 5 });
  const result = await probe.probe();
  assert.equal(child.killed, true);
  assert.deepEqual(result, unavailable('cuda_probe_timeout'));
  assertNoProbeListeners(child);
});

test('probe shares the in-flight request and caches its completed result', async () => {
  const child = createChild();
  const fake = createSpawn(child);
  const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn });
  const first = probe.probe();
  const second = probe.probe();
  assert.equal(first, second);
  assert.equal(fake.calls.length, 1);
  closeSuccess(child);
  await first;
  assert.equal(await probe.probe(), await first);
  assert.equal(fake.calls.length, 1);
});

test('invalidate starts a fresh probe after a completed result', async () => {
  const firstChild = createChild();
  const secondChild = createChild();
  const fake = createSpawn(firstChild, secondChild);
  const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn });
  const first = probe.probe();
  closeSuccess(firstChild, 'CUDA0: NVIDIA First');
  await first;
  probe.invalidate();
  const second = probe.probe();
  closeSuccess(secondChild, 'CUDA1: NVIDIA Second');
  assert.deepEqual(await second, {
    usable: true, requestedDevice: 'CUDA_AUTO', actualDevice: 'CUDA1', deviceName: 'NVIDIA Second', fallbackReason: null,
  });
  assert.equal(fake.calls.length, 2);
});

test('invalidate kills an active probe and late old events cannot poison a fresh cache generation', async () => {
  const oldChild = createChild();
  const newChild = createChild();
  const fake = createSpawn(oldChild, newChild);
  const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn });
  const oldPromise = probe.probe();
  probe.invalidate();
  assert.equal(oldChild.killed, true);
  const newPromise = probe.probe();
  oldChild.stdout.emit('data', Buffer.from('CUDA0: NVIDIA Old'));
  oldChild.emit('close', 0, null);
  closeSuccess(newChild, 'CUDA2: NVIDIA New');
  assert.deepEqual(await newPromise, {
    usable: true, requestedDevice: 'CUDA_AUTO', actualDevice: 'CUDA2', deviceName: 'NVIDIA New', fallbackReason: null,
  });
  assert.deepEqual(await oldPromise, unavailable('cuda_probe_invalidated'));
  assert.equal(fake.calls.length, 2);
  assert.equal(await probe.probe(), await newPromise);
});

test('probe returns typed capability failures instead of rejecting', async () => {
  const child = createChild();
  const fake = createSpawn(child);
  const probe = new LlamaCudaProbe({ binaryPath: 'C:\\runtime\\cuda\\llama-server.exe', spawn: fake.spawn });
  const resultPromise = probe.probe();
  child.emit('error', new Error('ENOENT'));
  await assert.doesNotReject(resultPromise);
  assert.deepEqual(await resultPromise, unavailable('cuda_probe_spawn_failed'));
});

function unavailable(fallbackReason) {
  return {
    usable: false,
    requestedDevice: 'CUDA_AUTO',
    actualDevice: null,
    deviceName: null,
    fallbackReason,
  };
}

function assertNoProbeListeners(child) {
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
}
