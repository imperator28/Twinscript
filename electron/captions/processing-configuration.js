const TRANSCRIPTION_MODELS = new Set(['openai-live', 'whisper-local']);
const TRANSLATION_MODELS = new Set(['luna', 'hy-mt2-local']);

function resolveProcessingConfiguration(settings = {}) {
  const transcription = TRANSCRIPTION_MODELS.has(settings.transcriptionModel)
    ? settings.transcriptionModel
    : 'openai-live';
  const finalTranslation = TRANSLATION_MODELS.has(settings.finalTranslationModel)
    ? settings.finalTranslationModel
    : 'luna';
  const provisionalTranslation = settings.provisionalTranslation !== true
    ? null
    : settings.localTranslationAcceleration === true
      ? 'hy-mt2-local'
      : finalTranslation;
  return {
    transcription,
    finalTranslation,
    provisionalTranslation,
    requiresCredential: transcription === 'openai-live' || finalTranslation === 'luna',
    fullyLocal: transcription === 'whisper-local' && finalTranslation === 'hy-mt2-local',
  };
}

module.exports = {
  TRANSCRIPTION_MODELS,
  TRANSLATION_MODELS,
  resolveProcessingConfiguration,
};
