const test = require('node:test');
const assert = require('node:assert/strict');

const { CaptionSessionManager } = require('./caption-session-manager');


function localSettings(overrides = {}) {
  return {
    transcriptionModel: 'whisper-local',
    finalTranslationModel: 'hy-mt2-local',
    localTranslationAcceleration: true,
    provisionalTranslation: true,
    shadowEnabled: false,
    recordEvaluation: false,
    budgetUsd: 5,
    reorderWindowMs: 400,
    duplicateWindowMs: 1400,
    protectedTokens: [],
    glossary: [],
    primaryProfile: 'economy',
    shadowProfile: 'tiered',
    fastPath: true,
    ...overrides,
  };
}

function fakeLocalTranscriptionFactory() {
  return {
    create(model) {
      assert.equal(model, 'whisper-local');
      return {
        connect: async () => {},
        appendAudio: () => {},
        finish: async () => {},
      };
    },
  };
}

function fakeLocalTranslationFactory() {
  return {
    create(model) {
      assert.equal(model, 'hy-mt2-local');
      return { normalize: async () => ({ text: 'ok', sourceLanguage: 'en', usage: { inputTokens: 0, outputTokens: 0 } }) };
    },
  };
}

test('Whisper plus Hy-MT2 never touches cloud constructors or credentials', async () => {
  const forbidden = () => { throw new Error('cloud path touched'); };
  const settings = localSettings();
  const manager = new CaptionSessionManager({
    credentialStore: { get: forbidden },
    settingsStore: { get: () => settings, set: () => settings },
    transcriptionBackendFactory: fakeLocalTranscriptionFactory(),
    translationBackendFactory: fakeLocalTranslationFactory(),
    transcriptionFactory: forbidden,
    normalizerFactory: forbidden,
    localInferenceSupervisor: {
      prepare: async () => {},
      client: () => ({ request: async () => ({}) }),
    },
    meetingRecordController: {
      startSession: async () => null,
      stopSession: async () => null,
    },
  });

  await manager.start({ mode: 'live' });

  assert.equal(manager.processing.fullyLocal, true);
  await manager.stop();
});

test('full-local startup fails closed when the local host is unavailable', async () => {
  const forbidden = () => { throw new Error('cloud path touched'); };
  const settings = localSettings();
  const manager = new CaptionSessionManager({
    credentialStore: { get: forbidden },
    settingsStore: { get: () => settings, set: () => settings },
    transcriptionBackendFactory: fakeLocalTranscriptionFactory(),
    translationBackendFactory: fakeLocalTranslationFactory(),
    transcriptionFactory: forbidden,
    normalizerFactory: forbidden,
    localInferenceSupervisor: {
      prepare: async () => {
        const error = new Error('local host missing');
        error.code = 'local_host_missing';
        throw error;
      },
    },
  });

  await assert.rejects(manager.start({ mode: 'live' }), { code: 'local_host_missing' });
  assert.equal(manager.active, false);
});
