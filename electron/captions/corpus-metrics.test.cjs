'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  criticalValues,
  missingCriticalValues,
  wrongAudienceLanguage,
  percentile,
} = require('./corpus-metrics.js');

test('criticalValues extracts numbers with and without units', () => {
  assert.deepEqual(criticalValues('Torque to 18 Nm and hold 30 s'), ['18nm', '30s']);
  assert.deepEqual(criticalValues('Yield rose to 99.4%'), ['99.4%']);
  assert.deepEqual(criticalValues('no numbers at all'), []);
});

test('criticalValues ignores bare units with no digits', () => {
  assert.deepEqual(criticalValues('measured in mm and kg'), []);
});

test('missingCriticalValues flags a dropped number', () => {
  const lost = missingCriticalValues('Torque to 18 Nm', 'Torque to 15 Nm');
  assert.deepEqual(lost, ['18nm']);
});

test('missingCriticalValues flags a silently omitted number', () => {
  const lost = missingCriticalValues(
    'Ship 240 units by Friday',
    'Ship the units by Friday',
  );
  assert.deepEqual(lost, ['240']);
});

test('missingCriticalValues accepts a localized unit if digits survive', () => {
  // The unit may be reworded in translation; the number may not change.
  assert.deepEqual(missingCriticalValues('Hold 30 s', '保持 30 秒'), []);
});

test('missingCriticalValues accepts CJK numerals for the same value', () => {
  assert.deepEqual(missingCriticalValues('two of them', '两个'), []);
});

test('missingCriticalValues treats an empty translation as losing everything', () => {
  assert.deepEqual(missingCriticalValues('18 Nm and 30 s', ''), ['18nm', '30s']);
});

test('missingCriticalValues is not fooled by thousands separators', () => {
  assert.deepEqual(missingCriticalValues('1,200 units', '1200 units'), []);
});

test('a thousands separator survives adjacent words', () => {
  // Regression: whitespace is stripped before comparison, which glues the
  // number to the following word and used to defeat a \b-anchored separator
  // strip, so this corpus line reported a false dropped value.
  assert.deepEqual(
    missingCriticalValues('Prepare 1,500 pilot units.', 'Prepare 1,500 pilot units.'),
    [],
  );
  assert.deepEqual(
    missingCriticalValues('Prepare 1,500 pilot units.', '准备 1,500 台试产样机。'),
    [],
  );
});

test('a European decimal comma is not read as a thousands separator', () => {
  assert.deepEqual(missingCriticalValues('gap of 1,5 mm', 'gap of 15 mm'), ['1,5mm']);
});

test('wrongAudienceLanguage fires when English output is Chinese', () => {
  assert.equal(wrongAudienceLanguage('这是一个完整的中文句子。', 'en'), true);
});

test('wrongAudienceLanguage fires when Chinese output is English', () => {
  assert.equal(
    wrongAudienceLanguage('This is a complete English sentence.', 'zh'),
    true,
  );
});

test('wrongAudienceLanguage passes correctly targeted text', () => {
  assert.equal(
    wrongAudienceLanguage('This is a complete English sentence.', 'en'),
    false,
  );
  assert.equal(wrongAudienceLanguage('这是一个完整的中文句子。', 'zh'), false);
});

test('wrongAudienceLanguage under-reports mixed output, as documented', () => {
  // Pinning the known limitation so the report's caveat stays honest: if this
  // ever starts returning true, the caveat in run-w1-corpus.mjs is stale.
  const mixed = 'The 扭矩 spec is 18 Nm 请确认这个数值是否正确无误。';
  assert.equal(wrongAudienceLanguage(mixed, 'en'), false);
});

test('percentile uses nearest-rank and handles the edges', () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(values, 0.5), 50);
  assert.equal(percentile(values, 0.95), 100);
  assert.equal(percentile([42], 0.95), 42);
  assert.equal(percentile([], 0.5), null);
});

test('percentile is order-independent', () => {
  assert.equal(percentile([90, 10, 50, 30, 70], 0.5), 50);
});
