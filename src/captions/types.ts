export type Audience = 'en' | 'zh';
export type CaptionStatus = 'pending' | 'provisional' | 'final' | 'failed';

export interface TargetText {
  text: string;
  status: CaptionStatus;
  revision: number;
  passthrough: boolean;
  firstRenderedAt?: number;
  finalizedAt?: number;
  error?: { code: string; message: string };
}

export interface CaptionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  sourceChannel: 'microphone' | 'system';
  providerItemId: string;
  sourceText: string;
  sourceLanguage: 'en' | 'zh' | 'mixed' | 'unknown';
  routedAs: 'en' | 'zh' | 'mixed' | 'unknown';
  english: TargetText;
  chinese: TargetText;
  status: CaptionStatus;
  sourceStartedAt: number;
  sourceEndedAt?: number;
  firstTranscriptAt?: number;
  finalTranscriptAt?: number;
  provider: {
    transcriptionModel: string;
    normalizationModel: string;
    finalNormalizationModel?: string;
    profile: string;
  };
  usage: {
    transcriptionAudioMs: number;
    normalizationTokensIn: number;
    normalizationTokensOut: number;
    normalizationCalls: number;
    estimatedCostUsd: number;
  };
  suppressed?: boolean;
  suppressionReason?: string;
}

export interface AudienceCaption {
  id: string;
  sessionId: string;
  sequence: number;
  sourceChannel: 'microphone' | 'system';
  sourceText: string;
  sourceLanguage: string;
  audience: Audience;
  text: string;
  status: CaptionStatus;
  revision: number;
  passthrough: boolean;
  error?: { code: string; message: string };
  sourceStartedAt: number;
  firstRenderedAt?: number;
  finalizedAt?: number;
  suppressed?: boolean;
  suppressionReason?: string;
}

export interface SessionStatus {
  state: string;
  sessionId?: string;
  mode?: string;
  channel?: string;
  code?: string;
  message?: string;
}

export interface SessionMetrics {
  sessionId?: string;
  budgetUsd?: number;
  totalUsd?: number;
  ratio?: number;
  audioMs?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  normalizationCalls?: number;
  costByStage?: {
    transcriptionUsd: number;
    primaryUsd: number;
    shadowUsd: number;
  };
  elapsedMs?: number;
  levels?: Partial<Record<'microphone' | 'system', number>>;
  speaking?: Partial<Record<'microphone' | 'system', boolean>>;
  diagnostics?: {
    duplicateCandidates: number;
    suppressedDuplicates: number;
    droppedAudioMs: Record<'microphone' | 'system', number>;
    reconnects: Record<'microphone' | 'system', number>;
    providerErrors: number;
  };
  transport?: Partial<
    Record<
      'microphone' | 'system',
      {
        sentAudioMs: number;
        droppedAudioMs: number;
        pendingChunks: number;
        bufferedBytes: number;
        dropReason?: string;
      }
    >
  >;
  normalizationQueue?: { running: number; queued: number };
}

export interface EvaluationResult {
  sessionId: string;
  sequence: number;
  sourceChannel: 'microphone' | 'system';
  sourceText: string;
  screeningPrompt?: import('./screeningCorpus').ScreeningPrompt | null;
  primary: {
    profile: string;
    english: string;
    chinese: string;
    latencyMs: number;
  };
  shadow:
    | {
        profile: string;
        english: string;
        chinese: string;
        sourceLanguage: string;
        latencyMs: number;
      }
    | { error: string }
    | null;
  metrics: SessionMetrics;
  stageLatency: {
    transcriptionMs: number;
    reorderMs: number;
    normalizationMs: number;
    firstEnglishMs: number | null;
    firstChineseMs: number | null;
    endToEndMs: number;
  };
  signals: {
    sourceClass: 'en' | 'zh' | 'mixed' | 'unknown';
    mixedSource: boolean;
    wrongAudienceLanguage: { en: boolean; zh: boolean };
    missingProtectedTokens: { en: string[]; zh: string[] };
    fastPathDivergence: boolean;
    fastPathSimilarity: number | null;
  };
}

export type EvaluationFlag =
  | 'wrong-language'
  | 'omission'
  | 'hallucination'
  | 'number-unit-id'
  | 'terminology'
  | 'late'
  | 'flutter'
  | 'duplicate';

export interface EvaluationRating {
  sequence: number;
  preference: 'primary' | 'shadow' | 'tie' | 'skip';
  semanticScore: number | null;
  flags: EvaluationFlag[];
  notes: string;
  ratedAt: number;
}

export interface CaptionSettings {
  settingsVersion: number;
  layout: 'stacked' | 'side-by-side';
  primaryProfile: 'economy' | 'tiered' | 'quality';
  shadowProfile: 'economy' | 'tiered' | 'quality';
  shadowEnabled: boolean;
  fastPath: boolean;
  provisionalTranslation: boolean;
  vadEnabled: boolean;
  vadThreshold: number;
  delayProfile: 'minimal' | 'low' | 'default';
  budgetUsd: number;
  glossary: Array<{
    en: string;
    zh: string;
    aliases?: string[];
    doNotTranslate?: boolean;
  }>;
  captionFontScale: number;
  captionPaceMs: number;
  showSourceInControl: boolean;
  recordEvaluation: boolean;
  recordingRetentionDays: number;
  reorderWindowMs: number;
  duplicateWindowMs: number;
}
