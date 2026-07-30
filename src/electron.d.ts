export {};

type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

interface CredentialStatus {
  available: boolean;
  source: 'development-environment' | 'secure-storage' | 'missing';
  encryptionAvailable: boolean;
  repairRecommended?: boolean;
}

interface CaptionsAPI {
  credentialStatus(): Promise<Result<CredentialStatus>>;
  setCredential(value: string): Promise<Result<CredentialStatus>>;
  deleteCredential(): Promise<Result<CredentialStatus>>;
  repairCredential(): Promise<Result<
    CredentialStatus & {
      canceled: boolean;
      repaired?: boolean;
      relaunchRequired?: boolean;
    }
  >>;
  validateCredential(value?: string): Promise<Result<{ valid: boolean; error?: string }>>;
  requestMicrophoneAccess(): Promise<Result<{ granted: boolean; status: string }>>;
  getSettings(): Promise<Result<Record<string, unknown>>>;
  getGlossaryConfigurations(): Promise<Result<
    import('./captions/types').GlossaryConfigurationSummary[]
  >>;
  importGlossary(): Promise<Result<{
    canceled: boolean;
    settings?: Record<string, unknown>;
    duplicateCount?: number;
    rejectedRows?: number[];
  }>>;
  exportGlossary(): Promise<Result<{ canceled: boolean; filePath?: string }>>;
  setSettings(patch: Record<string, unknown>): Promise<Result<Record<string, unknown>>>;
  startSession(request: Record<string, unknown>): Promise<Result<Record<string, unknown>>>;
  stopSession(): Promise<Result<Record<string, unknown>>>;
  getSessionStatus(): Promise<Result<Record<string, unknown>>>;
  rateEvaluation(rating: {
    sequence: number;
    preference: 'primary' | 'shadow' | 'tie' | 'skip';
    semanticScore?: number | null;
    flags?: import('./captions/types').EvaluationFlag[];
    notes?: string;
  }): Promise<Result<import('./captions/types').EvaluationRating>>;
  setScreeningPrompt(
    prompt: import('./captions/screeningCorpus').ScreeningPrompt | null,
  ): Promise<Result<import('./captions/screeningCorpus').ScreeningPrompt | null>>;
  abortShadow(): Promise<Result<Record<string, unknown>>>;
  listRecordings(): Promise<Result<Array<{
    id: string;
    startedAt: number;
    endedAt?: number;
    counts: Record<string, number>;
  }>>>;
  showWindows(): Promise<Result<void>>;
  hideWindows(): Promise<Result<void>>;
  setLayout(layout: 'stacked' | 'side-by-side'): Promise<Result<{ layout: string }>>;
  exportSession(format: 'json' | 'markdown'): Promise<Result<{ canceled: boolean; filePath?: string }>>;
  openPrivacy(): Promise<Result<void>>;
  sendAudio(channel: 'microphone' | 'system', samples: Int16Array): void;
  supportsSystemAudio(): Promise<boolean>;
  listSystemAudioSources(): Promise<Array<{ deviceId: string; label: string }>>;
  connectSystemAudioSource(sourceId: string): Promise<unknown>;
  disconnectSystemAudioSource(): Promise<unknown>;
  checkScreenRecordingPermission(): Promise<{ status: string; platform: string }>;
  enableLoopbackAudio(): Promise<unknown>;
  disableLoopbackAudio(): Promise<unknown>;
  fixMonitorVolume(): Promise<unknown>;
  onCaption(callback: (event: import('./captions/types').CaptionEvent) => void): () => void;
  onAudienceCaption(callback: (event: import('./captions/types').AudienceCaption) => void): () => void;
  onStatus(callback: (status: import('./captions/types').SessionStatus) => void): () => void;
  onMetrics(callback: (metrics: import('./captions/types').SessionMetrics) => void): () => void;
  onEvaluation(callback: (result: import('./captions/types').EvaluationResult) => void): () => void;
  onLayout(callback: (layout: { layout: string }) => void): () => void;
  onSettings(callback: (settings: Record<string, unknown>) => void): () => void;
}

declare global {
  interface Window {
    captions: CaptionsAPI;
    electron: {
      invoke(channel: string, payload?: unknown): Promise<unknown>;
    };
  }
}
