const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { LocalInferenceClient } = require('./local-inference-client');


function fakeTransport() {
  const transport = new EventEmitter();
  transport.writes = [];
  transport.write = (line) => transport.writes.push(line);
  return transport;
}

test('client resolves only a correlated protocol-v1 reply', async () => {
  const transport = fakeTransport();
  const client = new LocalInferenceClient({ transport, timeoutMs: 100, generation: 1 });
  const pending = client.request('health', { sessionId: 's1' });
  const sent = JSON.parse(transport.writes[0]);

  transport.emit('message', { ...sent, requestId: 'wrong', type: 'health', generation: 1 });
  transport.emit('message', { ...sent, type: 'health', generation: 1, queueDepth: 0 });

  assert.equal((await pending).queueDepth, 0);
  client.dispose();
});

test('client rejects mismatched protocol and host generations', async () => {
  const transport = fakeTransport();
  const client = new LocalInferenceClient({ transport, timeoutMs: 100, generation: 2 });
  const first = client.request('health', { sessionId: 's1' });
  const sent = JSON.parse(transport.writes[0]);

  transport.emit('message', { ...sent, protocolVersion: 2, type: 'health', generation: 2 });
  await assert.rejects(first, { code: 'local_protocol_mismatch' });

  const second = client.request('health', { sessionId: 's1' });
  const sentAgain = JSON.parse(transport.writes[1]);
  transport.emit('message', { ...sentAgain, type: 'health', generation: 1 });
  await assert.rejects(second, { code: 'local_generation_stale' });
  client.dispose();
});

test('abort sends request.cancel and rejects the pending request', async () => {
  const transport = fakeTransport();
  const client = new LocalInferenceClient({ transport, timeoutMs: 100, generation: 1 });
  const controller = new AbortController();
  const pending = client.request('translate.preview', { sessionId: 's1' }, {
    signal: controller.signal,
  });
  const requestId = JSON.parse(transport.writes[0]).requestId;

  controller.abort();

  await assert.rejects(pending, { code: 'local_request_aborted' });
  const cancellation = JSON.parse(transport.writes[1]);
  assert.equal(cancellation.type, 'request.cancel');
  assert.equal(cancellation.requestId, requestId);
  client.dispose();
});

test('transport close rejects every pending request', async () => {
  const transport = fakeTransport();
  const client = new LocalInferenceClient({ transport, timeoutMs: 100, generation: 1 });
  const first = client.request('health', { sessionId: 's1' });
  const second = client.request('health', { sessionId: 's2' });

  transport.emit('close');

  await assert.rejects(first, { code: 'local_host_closed' });
  await assert.rejects(second, { code: 'local_host_closed' });
});

test('transport write failure rejects and releases the pending request', async () => {
  const transport = fakeTransport();
  transport.write = async () => { throw new Error('pipe closed'); };
  const client = new LocalInferenceClient({ transport, timeoutMs: 100 });

  await assert.rejects(client.request('health'), { code: 'local_transport_write_failed' });
  assert.equal(client.pending.size, 0);
  client.dispose();
});
