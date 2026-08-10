const test = require('node:test');
const assert = require('node:assert/strict');

const { createTranslationPolicy, translationState } = require('./translation-policy');


for (const row of [
  { final: 'luna', accel: false, early: true, preview: 'luna' },
  { final: 'luna', accel: true, early: true, preview: 'hy-mt2-local' },
  { final: 'hy-mt2-local', accel: false, early: true, preview: 'hy-mt2-local' },
  { final: 'hy-mt2-local', accel: true, early: true, preview: 'hy-mt2-local' },
  { final: 'luna', accel: true, early: false, preview: null },
]) {
  test(JSON.stringify(row), () => {
    const policy = createTranslationPolicy({
      finalTranslationModel: row.final,
      localTranslationAcceleration: row.accel,
      provisionalTranslation: row.early,
    });
    assert.equal(policy.previewBackend, row.preview);
    assert.equal(policy.finalBackend, row.final);
  });
}

test('late preview cannot replace an authoritative final', () => {
  const state = translationState();
  state.acceptFinal({ utteranceId: 'u1', sourceRevision: 3, text: 'final' });

  assert.equal(
    state.acceptPreview({ utteranceId: 'u1', sourceRevision: 2, text: 'late' }),
    false,
  );
  assert.equal(state.get('u1').text, 'final');
});

test('a newer preview can replace only an older preview', () => {
  const state = translationState();
  assert.equal(state.acceptPreview({ utteranceId: 'u1', sourceRevision: 1, text: 'one' }), true);
  assert.equal(state.acceptPreview({ utteranceId: 'u1', sourceRevision: 2, text: 'two' }), true);
  assert.equal(state.acceptPreview({ utteranceId: 'u1', sourceRevision: 1, text: 'old' }), false);
  assert.equal(state.get('u1').text, 'two');
});
