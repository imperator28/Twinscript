const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');

const root = path.resolve(__dirname, '..');

test('every protocol example validates against v1', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'contracts/protocol-v1.schema.json')));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  const lines = fs.readFileSync(path.join(root, 'contracts/protocol-examples.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse);
  for (const message of lines) {
    assert.equal(validate(message), true, JSON.stringify(validate.errors));
  }
});

test('result messages cannot omit truthful device evidence', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'contracts/protocol-v1.schema.json')));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  assert.equal(validate({
    protocolVersion: 1,
    type: 'translate.result',
    requestId: 'r1',
    sessionId: 's1',
    utteranceId: 'u1',
    sourceRevision: 1,
    text: '已确认',
  }), false);
});

test('audio payloads are fixed to the existing 24 kHz PCM contract', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'contracts/protocol-v1.schema.json')));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  assert.equal(validate({
    protocolVersion: 1,
    type: 'asr.audio',
    requestId: 'r1',
    sessionId: 's1',
    channel: 'microphone',
    encoding: 'pcm_s16le',
    sampleRate: 16000,
    capturedAt: 1,
    audio: 'AAAA',
  }), false);
});
