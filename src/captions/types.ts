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
  elapsedMs?: number;
  levels?: Partial<Record<'microphone' | 'system', number>>;
  speaking?: Partial<Record<'microphone' | 'system', boolean>>;
}

export interface EvaluationResult {
  sessionId: string;
  sequence: number;
  sourceChannel: 'microphone' | 'system';
  sourceText: string;
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
}

export interface CaptionSettings {
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
  showSourceInControl: boolean;
  recordEvaluation: boolean;
  recordingRetentionDays: number;
}
