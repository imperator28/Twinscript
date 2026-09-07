import type { LocalModelId, LocalModelStatus } from './types';

interface PipelineSelection {
  transcriptionModel: string;
  finalTranslationModel: string;
  provisionalTranslation?: boolean;
  localTranslationAcceleration?: boolean;
}

export function requiredLocalModels(selection: PipelineSelection): LocalModelId[] {
  const ids: LocalModelId[] = [];
  if (selection.transcriptionModel === 'whisper-local') ids.push('whisper-small');
  if (selection.finalTranslationModel === 'hy-mt2-local'
      || (selection.provisionalTranslation === true && selection.localTranslationAcceleration === true)) {
    ids.push('hy-mt2-1.8b');
  }
  return ids;
}

export function missingLocalModels(required: LocalModelId[], status: LocalModelStatus | null): LocalModelId[] {
  return [...new Set(required)].filter((id) => status?.models[id]?.ready !== true);
}
