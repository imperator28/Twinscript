const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('local Whisper bounds decoder work for each short live utterance', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/openvino_whisper_engine.cpp'),
    'utf8',
  );

  assert.match(source, /config\.task\s*=\s*"transcribe"/);
  assert.match(source, /config\.max_new_tokens\s*=\s*64/);
});
