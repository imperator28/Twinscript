const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAINormalizer } = require('./openai-normalizer');

function harness(payload) {
  const requests = [], usage = [];
  const normalizer = new OpenAINormalizer({ apiKey: 'test', onUsage: u => usage.push(u),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => payload, headers: new Map() };
    },
  });
  return { requests, usage, run: sourceText => normalizer.normalize({ sourceText, target: 'zh', final: true }) };
}

test('normalizer scales its output allowance for long code-switched utterances and caps it', async () => {
  const h = harness({ output_text: JSON.stringify({ source_language: 'mixed', text: '确认 EVT' }) });
  for (const source of ['Confirm EVT', '尺寸 0.05 mm and tooling Rev C. '.repeat(30), 'x'.repeat(10000)]) await h.run(source);
  assert.ok(h.requests[1].max_output_tokens > h.requests[0].max_output_tokens);
  assert.equal(h.requests[2].max_output_tokens, 4096);
});

for (const [name, output] of [
  ['truncated JSON', { output_text: '{"text":' }],
  ['incomplete response with valid JSON', { status: 'incomplete', output_text: '{"source_language":"en","text":"partial"}' }],
  ['empty translation', { output_text: '{"source_language":"en","text":" "}' }],
  ['invalid schema', { output_text: '{"source_language":"invalid","text":42}' }],
]) test(`normalizer accounts billed usage and rejects ${name}`, async () => {
  const h = harness({ ...output, usage: { input_tokens: 20, output_tokens: 8 } });
  await assert.rejects(h.run('Please check EVT 3'), e => e.code.startsWith('normalization_'));
  assert.deepEqual(h.usage.map(u => [u.inputTokens, u.outputTokens]), [[20, 8]]);
  assert.equal(h.requests.length, 1, 'invalid output must not trigger hidden paid retries');
});

test('final output that still loses engineering literals after one retry fails visibly and accounts both attempts', async () => {
  const usage = [];
  let attempts = 0;
  const normalizer = new OpenAINormalizer({ apiKey: 'test', onUsage: u => usage.push(u),
    fetchImpl: async () => {
      attempts++;
      return { ok: true, headers: new Map(), json: async () => ({
        output_text: JSON.stringify({ source_language: 'mixed', text: '确认试产' }),
        usage: { input_tokens: 20, output_tokens: 8 },
      }) };
    },
  });
  await assert.rejects(normalizer.normalize({ sourceText: 'Confirm PVT 试产', target: 'zh', final: true, protectedTokens: ['PVT'] }),
    error => error.code === 'normalization_protected_token_missing');
  assert.equal(attempts, 2);
  assert.equal(usage.length, 2);
});

test('engineering literals next to Han text remain tokens without matching inside Latin identifiers', () => {
  const { findProtectedTokens, canonicalizeProtectedTokens } = require('./openai-normalizer');
  assert.deepEqual(findProtectedTokens('把DVT试产移到周五，确认T1。', ['DVT', 'T1']), ['DVT', 'T1']);
  assert.deepEqual(findProtectedTokens('preDVTpost T10', ['DVT', 'T1']), []);
  assert.equal(canonicalizeProtectedTokens('把dvt试产移到周五', ['DVT']), '把DVT试产移到周五');
});
