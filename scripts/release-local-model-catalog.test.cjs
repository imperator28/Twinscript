const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { assertReleaseCatalog } = require('./release-local-model-catalog.cjs');
test('shipping catalog exists and its signature validates', () => {
  const catalog = assertReleaseCatalog(path.join(__dirname, '../resources/local-models'));
  assert.equal(catalog.models.length, 2);
  for (const model of catalog.models) for (const file of model.files) assert.match(file.url, /^https:\/\//);
});
test('missing shipping catalog fails closed without generating beta metadata', () => {
  assert.throws(() => assertReleaseCatalog(path.join(__dirname, 'missing-release-catalog')), /Missing signed release catalog/);
});
