const assert = require('node:assert/strict');
const test = require('node:test');

const { LocalModelAdmissionGate } = require('./local-model-admission');

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test('session admission waits for an in-flight model mutation before leasing the meeting', async () => {
  const gate = new LocalModelAdmissionGate();
  const mutation = deferred();
  const mutating = gate.runMutation(() => mutation.promise);
  let admitted = false;
  const starting = gate.acquireSession().then((release) => {
    admitted = true;
    return release;
  });

  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(gate.isSessionActive(), false);

  mutation.resolve();
  await mutating;
  const release = await starting;
  assert.equal(gate.isSessionActive(), true);
  release();
  assert.equal(gate.isSessionActive(), false);
});

test('model mutation is rejected while a session lease covers startup and runtime', async () => {
  const gate = new LocalModelAdmissionGate();
  const release = await gate.acquireSession();

  await assert.rejects(gate.runMutation(async () => {}), { code: 'meeting_active' });

  release();
});
