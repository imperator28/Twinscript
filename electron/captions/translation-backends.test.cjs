const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LocalHyMt2Backend,
  TranslationBackendFactory,
} = require('./translation-backends');


test('Hy-MT2 conforms to the normalizer result shape', async () => {
  const client = {
    request: async (_type, payload) => ({
      text: '已确认',
      model: 'hy-mt2-1.8b',
      runtime: 'llama.cpp',
      actualDevice: 'CPU',
      inputTokens: 4,
      outputTokens: 3,
      sourceRevision: payload.sourceRevision,
    }),
  };
  const result = await new LocalHyMt2Backend({ client, sessionId: 's1' }).normalize({
    sourceText: 'Confirmed',
    target: 'zh',
    final: true,
    utteranceId: 'u1',
    sourceRevision: 2,
  });

  assert.equal(result.text, '已确认');
  assert.equal(result.model, 'hy-mt2-1.8b');
  assert.equal(result.runtime, 'llama.cpp');
  assert.equal(result.actualDevice, 'CPU');
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 3 });
});

test('Hy-MT2 uses preview or final operation without changing authority', async () => {
  const calls = [];
  const backend = new LocalHyMt2Backend({
    client: {
      request: async (type, payload, options) => {
        calls.push([type, payload, options]);
        return { text: 'ok' };
      },
    },
    sessionId: 's1',
  });

  await backend.normalize({ sourceText: 'one', target: 'en', final: false });
  await backend.normalize({ sourceText: 'two', target: 'zh', final: true });

  assert.equal(calls[0][0], 'translate.preview');
  assert.equal(calls[1][0], 'translate.final');
  assert.equal(calls[0][1].targetLanguage, 'English');
  assert.equal(calls[1][1].targetLanguage, 'Chinese');
});

test('translation factory preserves the existing Luna normalizer', () => {
  class LunaNormalizer {}
  const factory = new TranslationBackendFactory({ LunaNormalizer });

  assert.ok(factory.create('luna', {}) instanceof LunaNormalizer);
});

test('Hy-MT2 automatically protects engineering literals and forwards glossary context', async () => {
  let sent;
  const backend = new LocalHyMt2Backend({
    client: {
      request: async (_type, payload) => {
        sent = payload;
        return { text: 'Priya 确认使用 24 VDC。' };
      },
    },
    sessionId: 's1',
  });

  await backend.normalize({
    sourceText: 'Priya confirmed the sensor for DVT uses 24 VDC at ±0.2 mm.',
    target: 'zh',
    final: true,
    protectedTokens: ['Priya'],
    glossary: [{ en: 'sensor', zh: '传感器' }],
  });

  assert.deepEqual(sent.protectedTokens, ['Priya', 'DVT', '24 VDC', '±0.2 mm']);
  assert.deepEqual(sent.glossary, [{ en: 'sensor', zh: '传感器' }]);
});

test('Hy-MT2 excludes glossary rows unrelated to the current utterance', async () => {
  let sent;
  const backend = new LocalHyMt2Backend({
    client: {
      request: async (_type, payload) => {
        sent = payload;
        return { text: 'the' };
      },
    },
    sessionId: 's1',
  });

  await backend.normalize({
    sourceText: 'the',
    target: 'en',
    final: true,
    glossary: [
      { en: 'boss', zh: '凸台' },
      { en: 'draft angle', zh: '拔模斜度' },
    ],
  });

  assert.deepEqual(sent.glossary, []);
});
