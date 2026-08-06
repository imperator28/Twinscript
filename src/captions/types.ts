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
  settled: boolean;
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
  meetingRecord?: MeetingRecordReview | null;
}

export interface BackupState {
  channel: 'microphone' | 'system';
  state: 'healthy' | 'degraded' | 'failed';
  chunkCount?: number;
  droppedMs?: number;
  reason?: string;
  error?: string;
}

export interface MeetingRecordManifest {
  sessionId: string;
  startedAt?: number;
  endedAt?: number;
  captionCount?: number;
  /**
   * `expired` is distinct from `discarded`: the operator chose to delete a discarded
   * recording, whereas an expired one aged out because more than five meetings went
   * undecided. Conflating them would report a deletion the operator never made.
   */
  audioRetention: 'pending' | 'kept' | 'discarded' | 'unavailable' | 'expired';
  channelAvailability?: Partial<Record<'microphone' | 'system', boolean>>;
  audioTracks?: Record<string, { status: string; filePath?: string }>;
}

export interface MeetingRecordReview {
  recording: boolean;
  sessionId?: string;
  sessionDir?: string;
  session?: MeetingRecordManifest;
  error?: { code: string; message?: string; channels?: Record<string, unknown> };
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
  normalizationContext?: {
    requests: number;
    totalGlossaryRows: number;
    totalPromptCharacters: number;
    lastGlossaryRows: number;
    lastPromptCharacters: number;
  };
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

export interface GlossaryTerm {
  en: string;
  zh: string;
  aliases: string[];
  doNotTranslate: boolean;
  priority: number;
}

export interface GlossaryConfiguration {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  regions: string[];
  domains: string[];
  protectedTokens: string[];
  terms: GlossaryTerm[];
}

export interface GlossaryConfigurationSummary {
  id: string;
  name: string;
  description: string;
  regions: string[];
  domains: string[];
  termCount: number;
}

export interface CaptionSettings {
  settingsVersion: number;
  layout: 'stacked' | 'side-by-side';
  outputMode: 'overlays' | 'virtual-camera';
  primaryProfile: 'economy' | 'tiered' | 'quality';
  shadowProfile: 'economy' | 'tiered' | 'quality';
  shadowEnabled: boolean;
  fastPath: boolean;
  provisionalTranslation: boolean;
  vadEnabled: boolean;
  vadThreshold: number;
  delayProfile: 'minimal' | 'low' | 'default';
  budgetUsd: number;
  glossaryConfigurationId: string;
  customGlossaryConfiguration: GlossaryConfiguration | null;
  /**
   * People, projects and sites being discussed. Not translation pairs: these tell the
   * model who is in the room so a supplier's name is transcribed rather than guessed at
   * phonetically. Bounded by the settings store, since they reach every request.
   */
  glossaryContextNotes: string[];
  glossary: GlossaryTerm[];
  protectedTokens: string[];
  glossaryStoredCount: number;
  captionFontScale: number;
  autoSaveTranscript: boolean;
  keepAudioAutomatically: boolean;
  meetingRecordsDirectory: string | null;
  captionHistoryEntries: number;
  captionTheme: 'blueprint' | 'graphite' | 'red-blue';
  captionOverlayHeight: number | null;
  captionAutoSizeGeneration?: number;
  showSourceInControl: boolean;
  recordEvaluation: boolean;
  recordingRetentionDays: number;
  reorderWindowMs: number;
  duplicateWindowMs: number;
}

export interface NativeCameraHealth {
  state:
    | 'unsupported'
    | 'not-installed'
    | 'repair-required'
    | 'stopped'
    | 'starting'
    | 'ready'
    | 'streaming'
    | 'restarting'
    | 'stopping'
    | 'failed';
  supported: boolean;
  installed: boolean;
  windowsBuild?: number;
  reason?: string | null;
  restartCount?: number;
  message?: string | null;
  code?: string | number | null;
}
