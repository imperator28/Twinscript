const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveProcessingConfiguration } = require('./processing-configuration');
const { SettingsStore } = require('./settings-store');


function settingsStoreFrom(settings) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'processing-settings-'));
  fs.writeFileSync(
    path.join(userData, 'caption-settings.json'),
    JSON.stringify(settings),
  );
  const store = new SettingsStore({ getPath: () => userData });
  store.cleanup = () => fs.rmSync(userData, { recursive: true, force: true });
  return store;
}

test('v13 settings migrate to the unchanged cloud main track', () => {
  const store = settingsStoreFrom({
    settingsVersion: 13,
    provisionalTranslation: true,
  });
  const settings = store.get();

  assert.equal(settings.settingsVersion, 14);
  assert.equal(settings.transcriptionModel, 'openai-live');
  assert.equal(settings.finalTranslationModel, 'luna');
  assert.equal(settings.localTranslationAcceleration, false);
  assert.equal(settings.provisionalTranslation, true);
  store.cleanup();
});

test('processing configuration derives cloud requirements and preview backend', () => {
  assert.deepEqual(resolveProcessingConfiguration({
    transcriptionModel: 'whisper-local',
    finalTranslationModel: 'luna',
    provisionalTranslation: true,
    localTranslationAcceleration: true,
  }), {
    transcription: 'whisper-local',
    finalTranslation: 'luna',
    provisionalTranslation: 'hy-mt2-local',
    requiresCredential: true,
    fullyLocal: false,
  });
});

test('all four transcription and final translation combinations are valid', () => {
  const combinations = [
    ['openai-live', 'luna', true, false],
    ['openai-live', 'hy-mt2-local', true, false],
    ['whisper-local', 'luna', true, false],
    ['whisper-local', 'hy-mt2-local', false, true],
  ];
  for (const [transcriptionModel, finalTranslationModel, requiresCredential, fullyLocal] of combinations) {
    const config = resolveProcessingConfiguration({
      transcriptionModel,
      finalTranslationModel,
      provisionalTranslation: true,
      localTranslationAcceleration: false,
    });
    assert.equal(config.requiresCredential, requiresCredential);
    assert.equal(config.fullyLocal, fullyLocal);
    assert.equal(config.finalTranslation, finalTranslationModel);
  }
});

test('unknown model choices fail safely to the existing cloud main track', () => {
  const store = settingsStoreFrom({
    settingsVersion: 14,
    transcriptionModel: 'unknown-asr',
    finalTranslationModel: 'unknown-translation',
    localTranslationAcceleration: 'yes',
  });
  const settings = store.get();

  assert.equal(settings.transcriptionModel, 'openai-live');
  assert.equal(settings.finalTranslationModel, 'luna');
  assert.equal(settings.localTranslationAcceleration, false);
  store.cleanup();
});
