const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_GLOSSARY_PROMPT_CHARACTERS,
  MAX_GLOSSARY_ROWS,
  compileGlossaryRequestContext,
} = require('./glossary-request-context');

const term = (en, zh, aliases = [], priority = 3) => ({
  en,
  zh,
  aliases,
  priority,
  doNotTranslate: false,
});

test('matches custom, English, Chinese, and regional aliases before fallback rows', () => {
  const custom = term('custom boss', '专用凸台', ['project boss'], 5);
  const flash = term('flash', '飞边', ['批锋', '披锋'], 5);
  const tooling = term('tooling trial', '试模', ['T0 trial'], 4);
  const fallback = term('draft angle', '脱模斜度', [], 5);

  const context = compileGlossaryRequestContext({
    sourceText: 'Review PROJECT BOSS and 批锋 during the T0 trial for T2.',
    glossary: [custom, flash, tooling, fallback],
    customTerms: [custom],
    protectedTokens: ['T1', 'T2', 'DVT'],
  });

  assert.deepEqual(
    context.glossary.slice(0, 3).map((entry) => entry.en),
    ['custom boss', 'flash', 'tooling trial'],
  );
  assert.deepEqual(context.protectedTokens, ['T2']);
  assert.equal(context.metrics.glossaryRows, context.glossary.length);
  assert.ok(
    context.metrics.promptCharacters <= MAX_GLOSSARY_PROMPT_CHARACTERS,
  );
});

test('matching is case-insensitive for Latin text and literal for Chinese aliases', () => {
  const context = compileGlossaryRequestContext({
    sourceText: 'The WALL THICKNESS and 行位 need review.',
    glossary: [
      term('wall thickness', '壁厚', [], 4),
      term('slide / slider', '滑块', ['行位'], 4),
    ],
    customTerms: [],
    protectedTokens: [],
  });
  assert.deepEqual(
    context.glossary.map((entry) => entry.en),
    ['wall thickness', 'slide / slider'],
  );
});

test('the exact row boundary selects no more than sixteen bilingual rows', () => {
  const glossary = Array.from({ length: 17 }, (_, index) =>
    term(`term-${index}`, `术语-${index}`, [], 5 - (index % 5)),
  );
  const context = compileGlossaryRequestContext({
    sourceText: glossary.map((entry) => entry.en).join(' '),
    glossary,
    customTerms: [],
    protectedTokens: [],
  });
  assert.equal(context.glossary.length, MAX_GLOSSARY_ROWS);
  assert.equal(context.metrics.glossaryRows, MAX_GLOSSARY_ROWS);
});

test('the prompt-character boundary stops before terminology exceeds 800 characters', () => {
  const glossary = Array.from({ length: 16 }, (_, index) =>
    term(
      `long-term-${index}-${'x'.repeat(70)}`,
      `长术语-${index}-${'字'.repeat(70)}`,
      [],
      5,
    ),
  );
  const context = compileGlossaryRequestContext({
    sourceText: glossary.map((entry) => entry.en).join(' '),
    glossary,
    customTerms: [],
    protectedTokens: ['T2', 'DVT'],
  });
  assert.ok(context.glossary.length < MAX_GLOSSARY_ROWS);
  assert.ok(
    context.metrics.promptCharacters <= MAX_GLOSSARY_PROMPT_CHARACTERS,
  );
  assert.deepEqual(context.protectedTokens, []);
});

test('only protected tokens detected in the current source consume the budget', () => {
  const context = compileGlossaryRequestContext({
    sourceText: 'Move dvt after T2; do not include EVT yet.',
    glossary: [],
    customTerms: [],
    protectedTokens: ['T1', 'T2', 'EVT', 'DVT', 'PVT'],
  });
  assert.deepEqual(context.protectedTokens, ['T2', 'EVT', 'DVT']);
  assert.ok(context.metrics.promptCharacters > 0);
});
