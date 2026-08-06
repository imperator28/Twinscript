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

interface CaptionPreviewVisibility {
  overlaysVisible: boolean;
  cameraStageVisible: boolean;
}

interface CaptionsAPI {
  /**
   * `process.platform` from the main process, which is the same value that chose the
   * window's title-bar style. Used to reserve space for OS chrome above the content
   * without the renderer sniffing the user agent and reaching a different answer.
   */
  platform?: string;
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
  chooseMeetingRecordsDirectory(): Promise<Result<{
    canceled: boolean;
    directory?: string;
    settings?: Record<string, unknown>;
  }>>;
  /** Opens the records folder itself; reveal needs a sessionId and so could not. */
  openMeetingRecordsFolder(): Promise<Result<{ directory: string }>>;
  listPendingMeetingRecords(): Promise<Result<
    import('./captions/types').MeetingRecordReview[]
  >>;
  keepMeetingAudio(
    sessionId: string,
  ): Promise<Result<import('./captions/types').MeetingRecordReview>>;
  discardMeetingAudio(
    sessionId: string,
  ): Promise<Result<import('./captions/types').MeetingRecordReview>>;
  revealMeetingRecord(
    sessionId: string,
  ): Promise<Result<{ sessionId: string; sessionDir: string }>>;
  exportMeetingRecord(
    sessionId: string,
  ): Promise<Result<{ canceled: boolean; filePath?: string }>>;
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
  showWindows(): Promise<Result<CaptionPreviewVisibility>>;
  hideWindows(): Promise<Result<CaptionPreviewVisibility>>;
  showCameraStage(): Promise<Result<CaptionPreviewVisibility>>;
  hideCameraStage(): Promise<Result<CaptionPreviewVisibility>>;
  getPreviewVisibility(): Promise<Result<CaptionPreviewVisibility>>;
  getCameraStageSnapshot(): Promise<Result<{
    status: import('./captions/types').SessionStatus;
    captions: import('./captions/types').AudienceCaption[];
  }>>;
  getNativeCameraHealth(): Promise<Result<import('./captions/types').NativeCameraHealth>>;
  installNativeCamera(): Promise<Result<import('./captions/types').NativeCameraHealth>>;
  repairNativeCamera(): Promise<Result<import('./captions/types').NativeCameraHealth>>;
  removeNativeCamera(): Promise<Result<import('./captions/types').NativeCameraHealth>>;
  retryNativeCamera(): Promise<Result<import('./captions/types').NativeCameraHealth>>;
  setLayout(layout: 'stacked' | 'side-by-side'): Promise<Result<{ layout: string }>>;
  reportCaptionContentHeight(
    audience: 'en' | 'zh',
    height: number,
    generation: number,
  ): Promise<Result<{ audience: 'en' | 'zh'; height: number; generation: number }>>;
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
  onBackupState(
    callback: (state: import('./captions/types').BackupState) => void,
  ): () => void;
  onPreviewVisibility(
    callback: (visibility: CaptionPreviewVisibility) => void,
  ): () => void;
  onNativeCameraHealth(
    callback: (health: import('./captions/types').NativeCameraHealth) => void,
  ): () => void;
  onPendingMeetingRecords(
    callback: (records: import('./captions/types').MeetingRecordReview[]) => void,
  ): () => void;
}

declare global {
  interface Window {
    captions: CaptionsAPI;
    electron: {
      invoke(channel: string, payload?: unknown): Promise<unknown>;
    };
  }
}
