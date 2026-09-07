import { describe, expect, it } from 'vitest';
import { requiredLocalModels, missingLocalModels } from './localModelSetup';
import type { LocalModelStatus } from './types';

describe('selected pipeline model setup', () => {
  it('requires only translation for a cloud transcription hybrid', () => {
    expect(requiredLocalModels({ transcriptionModel: 'openai-live', finalTranslationModel: 'hy-mt2-local' })).toEqual(['hy-mt2-1.8b']);
  });
  it('requires no local models for the cloud route', () => {
    expect(requiredLocalModels({ transcriptionModel: 'openai-live', finalTranslationModel: 'luna' })).toEqual([]);
  });
  it('includes early translation only when enabled', () => {
    const selection = { transcriptionModel: 'whisper-local', finalTranslationModel: 'luna', localTranslationAcceleration: true };
    expect(requiredLocalModels(selection)).toEqual(['whisper-small']);
    expect(requiredLocalModels({ ...selection, provisionalTranslation: true })).toEqual(['whisper-small', 'hy-mt2-1.8b']);
  });
  it('skips a ready model and deduplicates missing models', () => {
    const status = { models: { 'whisper-small': { ready: true }, 'hy-mt2-1.8b': { ready: false } } } as LocalModelStatus;
    expect(missingLocalModels(['whisper-small', 'hy-mt2-1.8b', 'hy-mt2-1.8b'], status)).toEqual(['hy-mt2-1.8b']);
  });
});
