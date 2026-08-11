import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  FolderOpen,
  KeyRound,
  ListChecks,
  Mic,
  Monitor,
  Moon,
  Play,
  Plus,
  Radio,
  RotateCcw,
  ShieldCheck,
  Square,
  Sun,
  Video,
  VolumeX,
  X,
} from 'lucide-react';
import {
  AudioCaptureController,
  MicrophonePreviewController,
  enumerateAudioDevices,
  type AudioDeviceOption,
} from './audioCapture';
import { type ChannelHealth, deriveChannelHealth } from './captureHealth';
import { captionThemeById, captionThemes } from './captionThemes';
import { type ReadinessId, reviewReadiness } from './readiness';
import {
  blankDraft,
  draftSections,
  draftsToTerms,
  filterTerms,
  parseContextNotes,
  type DraftTerm,
  type EffectiveGlossary,
} from './glossaryView';
import {
  ContextSection,
  LiteralSection,
  TermPairSection,
  TokenSection,
} from './GlossaryEditor';
import {
  reviewCopy as buildReviewCopy,
  reviewFacts as buildReviewFacts,
  reviewHeading as buildReviewHeading,
  formatSize,
} from './meetingReviewCopy';
import {
  READINESS_DISMISSED_KEY,
  resetLocalPreferences,
} from './localPreferences';
import {
  DELAY_OPTIONS,
  delayIndex,
  delayOption,
  delayProfileAt,
} from './captionDelay';
import {
  THEME_STORAGE_KEY,
  applyPlatform,
  bindTheme,
  readThemePreference,
  type ThemePreference,
} from './theme';
import { TwinscriptLogo } from './TwinscriptLogo';
import { LocalModelInstallCard, type LocalModelAction } from './LocalModelInstallCard';
import {
  APP_LICENSE,
  APP_LICENSE_URL,
  APP_NAME,
  APP_NAME_ZH,
  APP_VERSION,
  CREDITS,
  SIGNATURE,
} from './aboutCredits';
import type {
  CaptionEvent,
  GlossaryConfiguration,
  GlossaryConfigurationSummary,
  GlossaryTerm,
  CaptionSettings,
  BackupState,
  MeetingRecordReview,
  NativeCameraHealth,
  LocalModelId,
  LocalModelStatus,
  SessionMetrics,
  SessionStatus,
  TargetText,
} from './types';

type Tab = 'session' | 'settings';
type SessionOperation = 'idle' | 'starting' | 'stopping';
type CredentialState = {
  available: boolean;
  source: string;
  encryptionAvailable: boolean;
  repairRecommended?: boolean;
};

const DEFAULT_SETTINGS: CaptionSettings = {
  settingsVersion: 14,
  layout: 'stacked',
  outputMode: 'overlays',
  primaryProfile: 'economy',
  shadowProfile: 'tiered',
  shadowEnabled: false,
  fastPath: true,
  provisionalTranslation: true,
  transcriptionModel: 'openai-live',
  finalTranslationModel: 'luna',
  localTranslationAcceleration: false,
  vadEnabled: false,
  vadThreshold: 0.012,
  delayProfile: 'low',
  budgetUsd: 5,
  glossaryConfigurationId: 'universal-engineering',
  customGlossaryConfiguration: null,
  glossaryContextNotes: [],
  glossary: [],
  protectedTokens: [],
  glossaryStoredCount: 0,
  captionFontScale: 1,
  autoSaveTranscript: true,
  keepAudioAutomatically: false,
  meetingRecordsDirectory: null,
  captionHistoryEntries: 6,
  captionTheme: 'blueprint',
  captionOverlayHeight: null,
  showSourceInControl: true,
  recordEvaluation: false,
  recordingRetentionDays: 7,
  reorderWindowMs: 400,
  duplicateWindowMs: 1400,
};

function formatElapsed(milliseconds = 0) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function Level({ value = 0 }: { value?: number }) {
  // scaleX rather than width: this updates roughly 20 times a second while a meter
  // is live, and `width` forces layout on every one of those frames.
  const fill = Math.max(0.02, Math.min(1, value * 9));
  return (
    <span className="level">
      <i style={{ transform: `scaleX(${fill})` }} />
    </span>
  );
}

// Status is carried by an icon as well as a colour. A ring of green/amber/red pills
// leaves a red-green colourblind operator unable to tell a live channel from a dead
// one, and the label alone was a state name rather than a reading.
const CHANNEL_ICONS = {
  live: Radio,
  waiting: Clock,
  silent: VolumeX,
  unavailable: AlertTriangle,
} as const;

// One icon per readiness step, naming the thing rather than the problem, so the row
// is scannable before any of its text is read.
const READINESS_ICONS: Record<ReadinessId, typeof KeyRound> = {
  credential: KeyRound,
  microphone: Mic,
  camera: Video,
};

// A persistent per-channel badge. A dismissible notice is not enough: an
// operator must be able to look at the panel mid-meeting and see that the
// meeting channel is carrying nothing.
function ChannelBadge({ health }: { health: ChannelHealth }) {
  if (health.state === 'idle') return null;
  const Icon = CHANNEL_ICONS[health.state as keyof typeof CHANNEL_ICONS] ?? Clock;
  return (
    <span
      className={`channel-badge is-${health.state}`}
      title={health.detail}
      role={health.state === 'live' || health.state === 'waiting' ? undefined : 'alert'}
    >
      <Icon size={11} strokeWidth={2.5} aria-hidden="true" />
      {health.label}
    </span>
  );
}

function targetText(target: TargetText, audience: 'en' | 'zh') {
  if (target.text) return target.text;
  if (target.status === 'failed') {
    return audience === 'en' ? 'Translation unavailable' : '翻译暂不可用';
  }
  return audience === 'en' ? 'Translating…' : '正在翻译…';
}

function pipelineUsesCloud(settings: CaptionSettings) {
  return settings.transcriptionModel === 'openai-live' ||
    settings.finalTranslationModel === 'luna';
}

export function ControlApp() {
  const repairedLaunch = useRef(
    window.localStorage.getItem('captions.secureStorageRepaired') === '1',
  );
  const [tab, setTab] = useState<Tab>(
    repairedLaunch.current ? 'settings' : 'session',
  );
  const [settings, setSettingsState] = useState(DEFAULT_SETTINGS);
  const [credential, setCredential] = useState<CredentialState | null>(null);
  const [credentialIssue, setCredentialIssue] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [devices, setDevices] = useState<{ inputs: AudioDeviceOption[]; outputs: AudioDeviceOption[] }>({ inputs: [], outputs: [] });
  const [microphoneId, setMicrophoneId] = useState('');
  const [status, setStatus] = useState<SessionStatus>({ state: 'ready' });
  const [metrics, setMetrics] = useState<SessionMetrics>({});
  const [captions, setCaptions] = useState<CaptionEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [pairDrafts, setPairDrafts] = useState<DraftTerm[]>(
    () => draftSections([]).pairs,
  );
  const [literalDrafts, setLiteralDrafts] = useState<DraftTerm[]>(
    () => draftSections([]).literal,
  );
  // Kept as rows, not one blob of text: a textarea gives no per-entry remove and no count.
  const [contextEntries, setContextEntries] = useState<string[]>(['']);
  const [glossaryQuery, setGlossaryQuery] = useState('');
  const [effectiveGlossary, setEffectiveGlossary] =
    useState<EffectiveGlossary | null>(null);
  const [protectedTokenText, setProtectedTokenText] = useState('');
  const [glossaryConfigurations, setGlossaryConfigurations] = useState<
    GlossaryConfigurationSummary[]
  >([]);
  const [sessionActive, setSessionActive] = useState(false);
  const [operation, setOperation] = useState<SessionOperation>('idle');
  // Capture facts survive as state, separate from the dismissible notice, so a
  // failed loopback stays visible for the whole session.
  const [capture, setCapture] = useState({ microphone: false, system: false });
  const [captureWarning, setCaptureWarning] = useState('');
  const [backupStates, setBackupStates] = useState<
    Partial<Record<'microphone' | 'system', BackupState>>
  >({});
  const [meetingReview, setMeetingReview] = useState<MeetingRecordReview | null>(
    null,
  );
  const [reviewOrigin, setReviewOrigin] = useState<'stopped' | 'recovered'>(
    'stopped',
  );
  // Every recording still awaiting a decision, not just the first. The prompt used to
  // render `records[0]` and drop the rest on the floor, so a backlog built up
  // invisibly while the operator believed they had answered everything.
  const [backlog, setBacklog] = useState<MeetingRecordReview[]>([]);
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  // One armed reset at a time. Two independent flags could both be set, showing two
  // confirmation rows for two different scopes.
  const [pendingReset, setPendingReset] = useState<null | 'appearance' | 'all'>(null);
  const [recordsUsage, setRecordsUsage] = useState<{
    bytes: number;
    sessionCount: number;
    pendingBytes: number;
  } | null>(null);
  const [captureStartedAt, setCaptureStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [previewing, setPreviewing] = useState(false);
  const [previewLevel, setPreviewLevel] = useState(0);
  const [previewSystemLevel, setPreviewSystemLevel] = useState(0);
  const [previewSystemReady, setPreviewSystemReady] = useState(false);
  const [previewVisibility, setPreviewVisibility] = useState({
    overlaysVisible: false,
    cameraStageVisible: false,
  });
  const [nativeCameraHealth, setNativeCameraHealth] =
    useState<NativeCameraHealth | null>(null);
  const [localModels, setLocalModels] = useState<LocalModelStatus | null>(null);
  const [busyModel, setBusyModel] = useState<LocalModelId | null>(null);
  // Persisted: an operator who chose to run without a microphone, or to capture the
  // stage in OBS rather than install the camera, should not be asked again on every
  // launch. Only advisories are ever dismissed - see reviewReadiness.
  const [advisoriesDismissed, setAdvisoriesDismissed] = useState(
    () => window.localStorage.getItem(READINESS_DISMISSED_KEY) === '1',
  );
  // Second step of the inline delete confirmation. Reset whenever a different
  // meeting comes up for review, so a pending confirm cannot carry across.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() =>
    readThemePreference(window.localStorage),
  );
  const audio = useRef(new AudioCaptureController());
  const microphonePreview = useRef(new MicrophonePreviewController());
  const apiKeyInput = useRef<HTMLInputElement>(null);
  const whisperModelRow = useRef<HTMLElement>(null);
  const translationModelRow = useRef<HTMLElement>(null);
  const operationId = useRef(0);
  const active = sessionActive;

  const refreshCredentialStatus = () => {
    void window.captions.credentialStatus().then((result) => {
      if (!result.ok) return;
      setCredential(result.data);
      setCredentialIssue(Boolean(result.data.repairRecommended));
    });
  };

  useEffect(() => {
    let mounted = true;
    let localModelStatusGeneration = 0;
    const initialLocalModelStatusGeneration = localModelStatusGeneration;
    const handleStatus = (next: SessionStatus) => {
      setStatus(next);
      if (next.state === 'degraded' && next.message) {
        setNotice(next.message);
      }
      if (['starting', 'running', 'degraded', 'budget-warning'].includes(next.state)) {
        setSessionActive(true);
      }
      if (['stopped', 'budget-exhausted'].includes(next.state)) {
        setSessionActive(false);
      }
      if (next.meetingRecord?.recording) {
        setMeetingReview(next.meetingRecord);
        setReviewOrigin('stopped');
      }
    };
    const handleLocalModelStatus = (next: LocalModelStatus) => {
      localModelStatusGeneration += 1;
      setLocalModels(next);
    };
    const cleanups = [
      window.captions.onStatus(handleStatus),
      window.captions.onMetrics((value) => setMetrics((current) => ({ ...current, ...value, levels: { ...current.levels, ...value.levels }, speaking: { ...current.speaking, ...value.speaking } }))),
      window.captions.onCaption((event) => setCaptions((current) => {
        if (event.suppressed) {
          return current.filter((item) => item.id !== event.id);
        }
        const next = [...current];
        const index = next.findIndex((item) => item.id === event.id);
        if (index >= 0) next[index] = event;
        else next.push(event);
        return next.slice(-12);
      })),
      window.captions.onBackupState((value) => {
        setBackupStates((current) => ({ ...current, [value.channel]: value }));
      }),
      window.captions.onPendingMeetingRecords((records) => {
        setBacklog(records);
        if (records[0]) {
          setMeetingReview(records[0]);
          setReviewOrigin('recovered');
        }
      }),
      window.captions.onPreviewVisibility(setPreviewVisibility),
      window.captions.onNativeCameraHealth(setNativeCameraHealth),
      window.captions.onLocalModelStatus(handleLocalModelStatus),
    ];
    void window.captions.getPreviewVisibility().then((result) => {
      if (result.ok) setPreviewVisibility(result.data);
    });
    void window.captions.getNativeCameraHealth().then((result) => {
      if (result.ok) setNativeCameraHealth(result.data);
    });
    void window.captions.getLocalModelStatus().then((result) => {
      if (mounted && localModelStatusGeneration === initialLocalModelStatusGeneration && result.ok) {
        setLocalModels(result.data);
      }
    });
    void Promise.all([
      window.captions.getSettings(),
      window.captions.getGlossaryConfigurations(),
      window.captions.getSessionStatus(),
      window.captions.listPendingMeetingRecords(),
      enumerateAudioDevices().catch(() => ({ inputs: [], outputs: [] })),
    ]).then(([settingsResult, glossaryResult, sessionResult, pendingResult, deviceResult]) => {
      const loadedSettings = settingsResult.ok
        ? settingsResult.data as unknown as CaptionSettings
        : DEFAULT_SETTINGS;
      if (settingsResult.ok) {
        const next = loadedSettings;
        setSettingsState(next);
        // One helper populates all three editors, so first load and post-save cannot
        // drift apart - they used to duplicate the same term-formatting logic.
        const sections = draftSections(next.customGlossaryConfiguration?.terms);
        setPairDrafts(sections.pairs);
        setLiteralDrafts(sections.literal);
        setProtectedTokenText(
          next.customGlossaryConfiguration?.protectedTokens.join(', ') || '',
        );
        setContextEntries([...(next.glossaryContextNotes || []), '']);
      }
      if (glossaryResult.ok) setGlossaryConfigurations(glossaryResult.data);
      if (pipelineUsesCloud(loadedSettings)) refreshCredentialStatus();
      else {
        setCredential(null);
        setCredentialIssue(false);
      }
      if (sessionResult.ok && sessionResult.data.active) {
        setSessionActive(true);
        setStatus({ state: 'running' });
      }
      if (pendingResult.ok) {
        setBacklog(pendingResult.data);
        if (pendingResult.data[0]) {
          setMeetingReview(pendingResult.data[0]);
          setReviewOrigin('recovered');
        }
      }
      setDevices(deviceResult);
      setMicrophoneId(deviceResult.inputs[0]?.deviceId || '');
    });
    return () => {
      mounted = false;
      cleanups.forEach((cleanup) => cleanup());
      void microphonePreview.current.stop();
      void audio.current.stop();
    };
  }, []);

  // A confirm armed for one meeting must never survive into another: the second
  // click would delete audio the operator had not been asked about.
  useEffect(() => {
    setConfirmDiscard(false);
  }, [meetingReview?.sessionId]);

  // Re-binds on change so that switching to System starts following the OS again, and
  // switching away stops - an explicit choice must not move when the system flips.
  useEffect(() => bindTheme(theme), [theme]);

  useEffect(() => {
    applyPlatform(document.documentElement, window.captions?.platform);
  }, []);

  // Re-measured whenever a decision could have changed what is on disk - keeping audio
  // writes WAV files, deleting removes them - so the figure is never stale in the one
  // moment the operator is looking at it to decide.
  const refreshRecordsUsage = () => {
    void window.captions.getMeetingRecordsUsage?.().then((result) => {
      if (result.ok) setRecordsUsage(result.data);
    });
  };
  useEffect(refreshRecordsUsage, [backlog, meetingReview?.session?.audioRetention]);

  const refreshGlossaryTerms = () => {
    void window.captions.getGlossaryTerms?.().then((result) => {
      if (result.ok) setEffectiveGlossary(result.data);
    });
  };
  useEffect(refreshGlossaryTerms, []);

  const glossaryMatches = filterTerms(
    effectiveGlossary?.terms || [],
    glossaryQuery,
  );

  useEffect(() => {
    if (!repairedLaunch.current || tab !== 'settings' || !credential) return;
    repairedLaunch.current = false;
    window.localStorage.removeItem('captions.secureStorageRepaired');
    setNotice('Secure storage was repaired. Enter your API key to continue.');
    window.requestAnimationFrame(() => apiKeyInput.current?.focus());
  }, [credential, tab]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setMetrics((current) => ({ ...current, elapsedMs: (current.elapsedMs || 0) + 1000 }));
      // Drives the grace period after which a started-but-silent channel stops
      // reading as STARTING.
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const saveSettings = async (patch: Partial<CaptionSettings>) => {
    const previous = settings;
    const optimistic = { ...settings, ...patch };
    setSettingsState(optimistic);
    const result = await window.captions.setSettings(patch as Record<string, unknown>);
    if (!result.ok) {
      setSettingsState(previous);
      setNotice(result.error.message);
      return null;
    }
    const next = result.data as unknown as CaptionSettings;
    setSettingsState(next);
    if (pipelineUsesCloud(next) && !pipelineUsesCloud(previous)) {
      refreshCredentialStatus();
    } else if (!pipelineUsesCloud(next)) {
      setCredential(null);
      setCredentialIssue(false);
    }
    return next;
  };

  const switchOutputMode = async (
    outputMode: CaptionSettings['outputMode'],
  ) => {
    await saveSettings({ outputMode });
  };

  const switchLayout = async (layout: CaptionSettings['layout']) => {
    const previous = settings;
    setSettingsState({ ...settings, layout });
    const result = await window.captions.setLayout(layout);
    if (!result.ok) {
      setSettingsState(previous);
      setNotice(result.error.message);
      return;
    }
    const appliedLayout =
      result.data.layout === 'side-by-side' ? 'side-by-side' : 'stacked';
    setSettingsState((current) => ({ ...current, ...result.data, layout: appliedLayout }));
  };

  const selectedPreviewVisible =
    settings.outputMode === 'virtual-camera'
      ? previewVisibility.cameraStageVisible
      : previewVisibility.overlaysVisible;

  const toggleAudiencePreview = async () => {
    const result =
      settings.outputMode === 'virtual-camera'
        ? selectedPreviewVisible
          ? await window.captions.hideCameraStage()
          : await window.captions.showCameraStage()
        : selectedPreviewVisible
          ? await window.captions.hideWindows()
          : await window.captions.showWindows();
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    setPreviewVisibility(result.data);
  };

  const runNativeCameraAction = async (
    action: 'install' | 'repair' | 'remove' | 'retry',
  ) => {
    setBusy(true);
    setNotice('');
    const operation = {
      install: window.captions.installNativeCamera,
      repair: window.captions.repairNativeCamera,
      remove: window.captions.removeNativeCamera,
      retry: window.captions.retryNativeCamera,
    }[action];
    const result = await operation();
    setBusy(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    setNativeCameraHealth(result.data);
  };

  const runLocalModelAction = async (action: LocalModelAction, modelId: LocalModelId) => {
    setBusyModel(modelId);
    setNotice('');
    try {
      if (action === 'remove') {
        const result = await window.captions.removeLocalModel(modelId);
        if (!result.ok) {
          setNotice(result.error.message);
          return;
        }
        setLocalModels(result.data.status);
        return;
      }

      const operation = {
        install: window.captions.installLocalModel,
        verify: window.captions.verifyLocalModel,
        repair: window.captions.repairLocalModel,
      }[action];
      const result = await operation(modelId);
      if (!result.ok) {
        setNotice(result.error.message);
        return;
      }
      setLocalModels(result.data);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Local model action could not complete.');
    } finally {
      setBusyModel(null);
    }
  };

  const focusLocalModel = (modelId: LocalModelId) => {
    const row = modelId === 'whisper-small' ? whisperModelRow.current : translationModelRow.current;
    if (!row) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    row.focus({ preventScroll: true });
  };

  const whisperLocalReady = localModels?.models['whisper-small'].ready ?? false;
  const translationLocalReady = localModels?.models['hy-mt2-1.8b'].ready ?? false;
  const whisperMissing = settings.transcriptionModel === 'whisper-local'
    && localModels !== null
    && !whisperLocalReady;
  const translationMissing = (settings.finalTranslationModel === 'hy-mt2-local'
    || settings.localTranslationAcceleration)
    && localModels !== null
    && !translationLocalReady;

  // Render the camera card unless we positively KNOW the platform cannot host it.
  // Gating on `supported === true` hid every action whenever a health report was
  // missing or had failed, which is how the panel came to have no way to install or
  // repair the camera. Absence of a report is not evidence of absence of support,
  // and user-agent sniffing is not either.
  const cameraCardVisible = nativeCameraHealth?.supported !== false;

  const nativeCameraMessage = (() => {
    // No report yet is a distinct state from "not supported". Conflating them told
    // Windows users to install OBS while the camera sat there working.
    if (!nativeCameraHealth) return 'Checking the virtual camera…';
    if (!nativeCameraHealth.supported) {
      return 'This system cannot host the virtual camera. Capture the Twinscript Camera Stage window in OBS instead.';
    }
    // The registration check supplies its own text for every failure it can name,
    // so it is preferred over anything guessed from the state alone.
    if (nativeCameraHealth.message) return nativeCameraHealth.message;
    if (!nativeCameraHealth.installed) {
      return 'The virtual camera is not installed yet. Install it once; Windows will ask for approval.';
    }
    return 'Twinscript is listed as a camera in your meeting app. Select Virtual camera here, then pick Twinscript there.';
  })();

  const start = async () => {
    const id = ++operationId.current;
    setSessionActive(true);
    setOperation('starting');
    setBusy(true);
    setNotice('');
    setCaptions([]);
    setMetrics({});
    setCapture({ microphone: false, system: false });
    setCaptureWarning('');
    setBackupStates({});
    setMeetingReview(null);
    setStatus({ state: 'starting', mode: 'live' });
    await microphonePreview.current.stop();
    setPreviewing(false);
    setPreviewLevel(0);
    setPreviewSystemLevel(0);
    setPreviewSystemReady(false);
    const result = await window.captions.startSession({
      mode: 'live',
      settings: {
        ...settings,
        shadowEnabled: false,
        recordEvaluation: false,
      },
      screeningPrompt: null,
    });
    if (id !== operationId.current) return;
    if (!result.ok) {
      setNotice(result.error.message);
      if (result.error.code === 'credential_unlock_failed') {
        setCredentialIssue(true);
      }
      setStatus({ state: 'ready' });
      setSessionActive(false);
      setOperation('idle');
      setBusy(false);
      return;
    }
    try {
      const started = await audio.current.start(microphoneId || undefined);
      if (id !== operationId.current) {
        await audio.current.stop();
        return;
      }
      setCapture({ microphone: started.microphone, system: started.system });
      setCaptureStartedAt(Date.now());
      setNow(Date.now());
      setCaptureWarning(started.warning || '');
    } catch (error) {
      await window.captions.stopSession();
      if (id !== operationId.current) return;
      setNotice(error instanceof Error ? error.message : 'Audio capture could not start');
      setStatus({ state: 'ready' });
      setCapture({ microphone: false, system: false });
      setSessionActive(false);
      setOperation('idle');
      setBusy(false);
      return;
    }
    if (id !== operationId.current) return;
    setStatus({ state: 'running', mode: 'live' });
    setOperation('idle');
    setBusy(false);
  };

  const stop = async () => {
    ++operationId.current;
    setOperation('stopping');
    setBusy(true);
    try {
      await audio.current.stop();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Audio capture could not stop cleanly');
    }
    const result = await window.captions.stopSession();
    if (!result.ok) {
      setNotice(result.error.message);
    } else {
      const next = result.data.meetingRecord as MeetingRecordReview | undefined;
      if (next?.recording) {
        setMeetingReview(next);
        setReviewOrigin('stopped');
      }
    }
    setStatus({ state: 'stopped' });
    setCapture({ microphone: false, system: false });
    setCaptureWarning('');
    setSessionActive(false);
    setOperation('idle');
    setBusy(false);
  };

  const chooseMeetingRecordsDirectory = async () => {
    setBusy(true);
    const result = await window.captions.chooseMeetingRecordsDirectory();
    setBusy(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    if (result.data.settings) {
      setSettingsState(result.data.settings as unknown as CaptionSettings);
    }
  };

  // Takes an explicit sessionId so a backlog row can be decided without first being
  // promoted to the main card, and updates whichever list holds that session.
  const applyAudioDecision = async (
    decision: 'keep' | 'discard',
    sessionId?: string,
  ) => {
    const target = sessionId || meetingReview?.sessionId;
    if (!target) return;
    setBusy(true);
    const result =
      decision === 'keep'
        ? await window.captions.keepMeetingAudio(target)
        : await window.captions.discardMeetingAudio(target);
    setBusy(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    if (meetingReview?.sessionId === target) setMeetingReview(result.data);
    setBacklog((current) =>
      current.map((entry) =>
        entry.sessionId === target ? result.data : entry,
      ),
    );
  };

  const keepMeetingAudio = () => applyAudioDecision('keep');

  // Confirmation lives in the card as a two-step Delete audio -> Delete permanently,
  // not here. This used to raise window.confirm as well, which in Electron is a
  // blocking, unstyled native dialog - and once the inline step existed it became a
  // second prompt for the same decision. Two confirmations for one action is how
  // operators learn to click through both.
  const discardMeetingAudio = () => applyAudioDecision('discard');

  /**
   * Decides every outstanding recording in one action. An operator returning after a
   * few ignored meetings wants one answer, not five identical prompts.
   */
  const decideAllAudio = async (decision: 'keep' | 'discard') => {
    // Every undecided recording, including the one the main card is asking about. Running
    // over the backlog rows alone left that meeting pending after the operator had just
    // answered for "all" of them.
    for (const entry of allUndecided) {
      if (entry.sessionId) await applyAudioDecision(decision, entry.sessionId);
    }
    setConfirmDiscardAll(false);
  };

  const grantAudioAccess = async () => {
    setBusy(true);
    setNotice('');
    try {
      await microphonePreview.current.stop();
      setPreviewing(false);
      setPreviewLevel(0);
      setPreviewSystemLevel(0);
      setPreviewSystemReady(false);
      const permission = await window.captions.requestMicrophoneAccess();
      if (!permission.ok || !permission.data.granted) {
        throw new Error(
          permission.ok
            ? 'Microphone access is disabled. Enable Twinscript in System Settings → Privacy & Security → Microphone.'
            : permission.error.message,
        );
      }
      const next = await enumerateAudioDevices(true);
      if (!next.inputs.length) throw new Error('No microphone was found.');
      const selected = next.inputs.some((device) => device.deviceId === microphoneId)
        ? microphoneId
        : next.inputs[0].deviceId;
      setDevices(next);
      setMicrophoneId(selected);
      const preview = await microphonePreview.current.start(
        selected,
        setPreviewLevel,
        setPreviewSystemLevel,
      );
      setPreviewing(true);
      setPreviewSystemReady(preview.system);
      // The meeting channel is metered too, so the test now covers the capture a
      // session actually depends on rather than half of it.
      setNotice(
        preview.system
          ? 'Both channels are live. Speak for the microphone meter, and play meeting audio for the meeting meter.'
          : preview.warning ||
              'Microphone is active. System audio could not be captured.',
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Microphone access could not be started.',
      );
    } finally {
      setBusy(false);
    }
  };

  const selectMicrophone = async (deviceId: string) => {
    setMicrophoneId(deviceId);
    if (!previewing) return;
    try {
      // The system callback must be passed here too. Omitting it restarts the
      // preview with the microphone only, so switching device would silently kill
      // the meeting meter and recreate the very confusion this fixes.
      const preview = await microphonePreview.current.start(
        deviceId || undefined,
        setPreviewLevel,
        setPreviewSystemLevel,
      );
      setPreviewSystemReady(preview.system);
    } catch (error) {
      setPreviewing(false);
      setPreviewLevel(0);
      setPreviewSystemLevel(0);
      setPreviewSystemReady(false);
      setNotice(
        error instanceof Error
          ? error.message
          : 'The selected microphone could not be started.',
      );
    }
  };

  const saveKey = async () => {
    if (!keyInput.trim()) return;
    setBusy(true);
    const validated = await window.captions.validateCredential(keyInput.trim());
    if (!validated.ok || !validated.data.valid) {
      setNotice(validated.ok ? validated.data.error || 'The API key is not valid' : validated.error.message);
      setBusy(false);
      return;
    }
    const result = await window.captions.setCredential(keyInput.trim());
    if (result.ok) {
      setCredential(result.data);
      setCredentialIssue(false);
      setKeyInput('');
      setNotice('API key validated and stored in this computer’s secure storage.');
    } else {
      setCredentialIssue(result.error.code === 'credential_unlock_failed');
      setNotice(result.error.message);
    }
    setBusy(false);
  };

  const testSavedKey = async () => {
    setBusy(true);
    setNotice('');
    const result = await window.captions.validateCredential();
    const unlockFailed =
      !result.ok && result.error.code === 'credential_unlock_failed';
    setCredentialIssue(unlockFailed);
    setNotice(
      result.ok && result.data.valid
        ? 'OpenAI API connection succeeded. The saved key can access GPT Live Transcribe.'
        : result.ok
          ? result.data.error || 'OpenAI API connection failed.'
          : result.error.message,
    );
    setBusy(false);
  };

  const repairCredential = async () => {
    setBusy(true);
    const result = await window.captions.repairCredential();
    if (!result.ok) {
      setNotice(result.error.message);
      setBusy(false);
      return;
    }
    if (result.data.canceled) {
      setBusy(false);
      window.requestAnimationFrame(() => apiKeyInput.current?.focus());
      return;
    }
    setCredential(result.data);
    setCredentialIssue(false);
    setKeyInput('');
    if (result.data.relaunchRequired) {
      window.localStorage.setItem('captions.secureStorageRepaired', '1');
      setNotice('Secure storage repaired. Restarting the app…');
      return;
    }
    setNotice('Secure storage repaired. Enter your API key to continue.');
    setBusy(false);
    window.requestAnimationFrame(() => apiKeyInput.current?.focus());
  };

  const parseProtectedTokens = () =>
    protectedTokenText
      .split(/[,\n;]/)
      .map((token) => token.trim())
      .filter(Boolean);

  // The "en = zh" textarea is gone, so there is no line-parsing step left here: rows
  // carry their own two fields and a do-not-translate flag, which the old format could
  // not express at all.
  const syncGlossaryEditors = (next: CaptionSettings) => {
    const sections = draftSections(next.customGlossaryConfiguration?.terms);
    setPairDrafts(sections.pairs);
    setLiteralDrafts(sections.literal);
    setProtectedTokenText(
      next.customGlossaryConfiguration?.protectedTokens.join(', ') || '',
    );
    // Always one empty row so the section is never a dead end.
    setContextEntries([...(next.glossaryContextNotes || []), '']);
  };

  // The two term sections are edited independently and recombined on save, so a row
  // cannot silently change category by having a checkbox toggled.
  const sectionSetter = (section: 'pairs' | 'literal') =>
    section === 'pairs' ? setPairDrafts : setLiteralDrafts;

  const resetEverySetting = async () => {
    setBusy(true);
    const result = await window.captions.resetSettings();
    setBusy(false);
    setPendingReset(null);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    const next = result.data as unknown as CaptionSettings;
    setSettingsState(next);
    // The glossary editors hold their own copies of what was stored, so they have to be
    // repopulated or they would keep offering to save the terms that were just cleared.
    syncGlossaryEditors(next);
    refreshGlossaryTerms();
    setNotice('All settings reset. Your API key and saved meetings are unchanged.');
  };

  const updateDraft = (
    section: 'pairs' | 'literal',
    id: string,
    patch: Partial<DraftTerm>,
  ) => {
    sectionSetter(section)((current) => {
      const next = current.map((draft) =>
        draft.id === id ? { ...draft, ...patch } : draft,
      );
      // A blank row appears as soon as the last one is touched, so adding never needs a
      // separate click and the section never looks full.
      const last = next[next.length - 1];
      if (last && (last.en.trim() || last.zh.trim())) {
        next.push(blankDraft(section === 'literal'));
      }
      return next;
    });
  };

  const removeDraft = (section: 'pairs' | 'literal', id: string) => {
    sectionSetter(section)((current) => {
      const next = current.filter((draft) => draft.id !== id);
      return next.length ? next : [blankDraft(section === 'literal')];
    });
  };

  const addDraft = (section: 'pairs' | 'literal') => {
    sectionSetter(section)((current) => [
      ...current,
      blankDraft(section === 'literal'),
    ]);
  };

  const saveGlossaryOverrides = async () => {
    const { terms: draftTerms, incomplete } = draftsToTerms([
      ...pairDrafts,
      ...literalDrafts,
    ]);
    if (incomplete > 0) {
      // Refused rather than silently dropped: a row with one side filled is unfinished
      // work, and saving around it would lose what was typed with no explanation.
      setNotice(
        `${incomplete} row${incomplete === 1 ? '' : 's'} need both languages, or "Keep in English" ticked.`,
      );
      return;
    }
    const terms: GlossaryTerm[] = draftTerms.map((term) => ({
      en: term.en,
      zh: term.zh,
      aliases: [],
      doNotTranslate: term.doNotTranslate,
      priority: 5,
    }));
    const protectedTokens = parseProtectedTokens();
    const glossaryContextNotes = parseContextNotes(contextEntries.join('\n'));
    const customGlossaryConfiguration: GlossaryConfiguration | null =
      terms.length || protectedTokens.length
        ? {
            schemaVersion: 1,
            id: 'custom-overrides',
            name: 'Custom overrides',
            description: 'Project-specific meeting terminology.',
            regions: [],
            domains: [],
            protectedTokens,
            terms,
          }
        : null;
    const next = await saveSettings({
      customGlossaryConfiguration,
      glossaryContextNotes,
    });
    if (!next) return;
    syncGlossaryEditors(next);
    refreshGlossaryTerms();
    setNotice(
      customGlossaryConfiguration || glossaryContextNotes.length
        ? 'Glossary saved. It applies to the next session.'
        : 'Your glossary entries were cleared.',
    );
  };

  const importGlossary = async () => {
    setBusy(true);
    setNotice('');
    const result = await window.captions.importGlossary();
    setBusy(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    if (result.data.canceled || !result.data.settings) return;
    const next = result.data.settings as unknown as CaptionSettings;
    setSettingsState(next);
    syncGlossaryEditors(next);
    const details = [
      result.data.duplicateCount
        ? `${result.data.duplicateCount} duplicate${result.data.duplicateCount === 1 ? '' : 's'} merged`
        : '',
      result.data.rejectedRows?.length
        ? `${result.data.rejectedRows.length} invalid row${result.data.rejectedRows.length === 1 ? '' : 's'} skipped`
        : '',
    ].filter(Boolean);
    setNotice(`Glossary imported${details.length ? ` · ${details.join(' · ')}` : ''}.`);
  };

  const exportGlossary = async () => {
    setBusy(true);
    setNotice('');
    const result = await window.captions.exportGlossary();
    setBusy(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    if (!result.data.canceled) {
      setNotice('Portable glossary configuration saved.');
    }
  };

  /**
   * The most recent caption the audience has actually been shown.
   *
   * This used to fall back to `captions[captions.length - 1]` when nothing had settled yet,
   * which is a provisional caption - a mid-sentence fragment such as "Good morning,". The
   * audience surfaces only present settled text, so the preview displayed the first sentence
   * of every session before the overlays and camera stage did, and displayed a fragment the
   * audience never saw at all.
   *
   * The condition matches `settled` in projectForAudience exactly, so the swatch cannot lead
   * what it is previewing. With nothing settled it falls through to the placeholder copy.
   */
  const latest = useMemo(
    () =>
      [...captions]
        .reverse()
        .find(
          (caption) => caption.status === 'final' || caption.status === 'failed',
        ),
    [captions],
  );
  const universalGlossary = glossaryConfigurations[0];
  const channelHealth = (channel: 'microphone' | 'system'): ChannelHealth =>
    deriveChannelHealth({
      sessionActive: active,
      capturing: capture[channel],
      sentAudioMs: metrics.transport?.[channel]?.sentAudioMs,
      rms: metrics.levels?.[channel],
      msSinceStart: captureStartedAt ? now - captureStartedAt : 0,
    });
  const microphoneHealth = channelHealth('microphone');
  const systemHealth = channelHealth('system');
  const backupFailed = Object.values(backupStates).some(
    (value) => value?.state === 'failed',
  );
  const backupDegraded = Object.values(backupStates).some(
    (value) => value?.state === 'degraded',
  );
  const backupLabel = backupFailed
    ? 'BACKUP FAILED · TRANSCRIPT CONTINUES'
    : backupDegraded
      ? 'BACKUP PAUSED · DISK TOO SLOW'
      : capture.system
        ? 'TEMPORARY AUDIO BACKUP · MICROPHONE + MEETING'
        : 'TEMPORARY AUDIO BACKUP · MICROPHONE ONLY';
  const pendingDecision =
    meetingReview?.recording &&
    meetingReview.session?.audioRetention === 'pending';
  // Everything still awaiting an answer, excluding whichever record the main card is
  // already asking about, so a meeting is never presented twice in one prompt.
  // Two different lists, and conflating them was a bug.
  //
  // `undecidedOthers` drives the rendered rows and excludes whichever meeting the main
  // card is already asking about, so it is never shown twice.
  //
  // `allUndecided` drives the bulk actions and their labels, and includes it. "Delete all"
  // previously ran over the rows only, so it deleted the backlog and silently left the
  // meeting on screen still pending - the operator answered the prompt and the prompt
  // stayed.
  const undecidedOthers = backlog.filter(
    (entry) =>
      entry.session?.audioRetention === 'pending' &&
      entry.sessionId !== meetingReview?.sessionId,
  );
  const undecided = undecidedOthers;
  const allUndecided = [
    ...(pendingDecision && meetingReview ? [meetingReview] : []),
    ...undecidedOthers,
  ];
  const selectedTheme = captionThemeById(settings.captionTheme);

  // "Stop session", not "Stop". The stripe has room for it, and the accessible name has
  // to say what it stops - "Stop" alone next to a budget control is ambiguous.
  const sessionActionLabel =
    operation === 'stopping'
      ? 'Stopping…'
      : active
        ? 'Stop session'
        : 'Start session';
  const sessionCost = metrics.totalUsd || 0;
  const sessionBudget = settings.budgetUsd || 0;
  // Guarded: a zero budget would divide to Infinity and paint a full bar on a session
  // that has spent nothing.
  const budgetRatio = sessionBudget > 0 ? sessionCost / sessionBudget : 0;
  // The budget control appears only when the cap is actually in reach. Showing it for the
  // whole meeting would put a second control on the bar for the 90% of sessions that never
  // approach the limit, and would train the operator to ignore it by the time it matters.
  const budgetPressed = active && budgetRatio >= 0.8;
  // One place decides what is missing and how much it matters, so the checklist the
  // operator reads and the Start button they press cannot disagree.
  const usesCloudModels = pipelineUsesCloud(settings);
  const readiness = reviewReadiness({
    advisoriesDismissed: advisoriesDismissed,
    credentialRequired: usesCloudModels,
    credentialAvailable: Boolean(credential?.available),
    microphoneAvailable: devices.inputs.length > 0,
    outputMode: settings.outputMode,
    cameraInstalled: nativeCameraHealth ? nativeCameraHealth.installed : null,
    cameraSupported: nativeCameraHealth ? nativeCameraHealth.supported : null,
  });

  // Counted from `steps`, not `outstanding`: `outstanding` already has the dismissal
  // applied, so while dismissed it reads zero and the Settings card could not tell whether
  // restoring the checklist would reveal anything or nothing.
  const delaySelection = delayOption(settings.delayProfile);
  const checklistItemCount = readiness.steps.filter((step) => !step.done).length;
  const checklistHasItems = checklistItemCount > 0;

  const reviewHeading = buildReviewHeading(meetingReview?.session, reviewOrigin);
  const reviewCopy = buildReviewCopy(meetingReview?.session, reviewOrigin);
  const reviewFacts = buildReviewFacts(meetingReview?.session);

  const resolveReadiness = (id: ReadinessId) => {
    if (id === 'credential') {
      setTab('settings');
      window.requestAnimationFrame(() => apiKeyInput.current?.focus());
      return;
    }
    if (id === 'microphone') {
      void grantAudioAccess();
      return;
    }
    void runNativeCameraAction('install');
  };

  const sessionActionDisabled =
    operation === 'stopping' ||
    (!active && (busy || !readiness.canStart || Boolean(pendingDecision)));

  return (
    <main className="control-shell">
      <header className="app-header">
        {/* The mark is decorative: the wordmark it would announce is the very next
            thing in the reading order. */}
        <span className="brand-mark">
          <TwinscriptLogo size={34} />
        </span>
        <div>
          {/* The Chinese name sits in the operator UI rather than the audience
              overlays: the camera stage and lower thirds must stay free of
              branding (see docs/windows/virtual-camera.md). */}
          <p className="eyebrow">
            {APP_NAME.toUpperCase()}
            <span lang="zh-Hans"> {APP_NAME_ZH}</span>
          </p>
          <h1>Live Caption Studio</h1>
        </div>
      </header>

      {/* The primary action, docked bottom-centre so it is reachable without scrolling
          back to a header that has scrolled away. It is fixed chrome, so the shell
          reserves its height as bottom padding rather than letting it cover the last
          card - see `--dock-height` in the stylesheet.

          Idle it is a pill. Live it widens into a status stripe carrying the things an
          operator watches mid-meeting - elapsed time and spend against budget - so those
          are readable without leaving the meeting to find them. Stop is a button INSIDE
          the stripe rather than the stripe itself: the budget control has to be its own
          button, and a button cannot contain another button. */}
      <div className={`session-dock ${active ? 'is-live' : ''}`}>
        {/* Live, the whole bar IS the stop control - the readings sit inside it rather
            than beside a separate button, so there is one target and no dead red space.

            +$2 is a sibling, not a child: a button cannot contain another button. It stays
            mounted and collapsed to zero width so it can animate open, and is `disabled`
            while collapsed so it is neither focusable nor announced. It appears only near
            the cap, and because the bar's total width is fixed and the stop control
            flexes, opening it squeezes the stop control rather than widening the bar. */}
        <div
          className={`session-stripe ${active ? 'is-live' : ''} ${
            active && budgetRatio >= 1 ? 'is-over' : ''
          } ${budgetPressed ? 'needs-budget' : ''}`}
        >
          {active && (
            <button
              type="button"
              className="session-stripe__budget-add"
              // Raising the cap is the one setting needed mid-meeting; it was otherwise a
              // number field two tabs away. A fixed step keeps it one press, no typing.
              // `disabled` alone, no aria-hidden: disabled already removes it from the tab
              // order, and hiding it from the accessibility tree would make its name
              // uncomputable while telling a screen-reader user nothing useful. "Dimmed
              // until the cap is close" is an honest thing to announce.
              disabled={busy || !budgetPressed}
              onClick={() => void saveSettings({ budgetUsd: sessionBudget + 2 })}
            >
              <Plus size={14} strokeWidth={2.75} aria-hidden="true" />
              $2
            </button>
          )}

          <button
            type="button"
            className={`session-pill session-action ${active ? 'is-live' : ''}`}
            disabled={sessionActionDisabled}
            onClick={() => void (active ? stop() : start())}
          >
            {active ? (
              <>
                <span className="session-stripe__stat">
                  <span>Spend</span>
                  <strong
                    aria-label={`Spent $${sessionCost.toFixed(2)} of $${sessionBudget.toFixed(2)}`}
                  >
                    {/* Over budget the bar gains a ring; this icon means the state is not
                        carried by a boundary the eye may not catch either. */}
                    {budgetRatio >= 1 && (
                      <AlertTriangle size={13} strokeWidth={2.75} aria-hidden="true" />
                    )}
                    ${sessionCost.toFixed(2)}
                    <em> / ${sessionBudget.toFixed(2)}</em>
                  </strong>
                </span>
                <span className="session-stripe__action">
                  <Square size={13} strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
                  <strong>{sessionActionLabel}</strong>
                </span>
                <span className="session-stripe__stat session-stripe__stat--end">
                  <span>Elapsed</span>
                  <strong>{formatElapsed(metrics.elapsedMs)}</strong>
                </span>
              </>
            ) : (
              <>
                {/* An icon naming the action, replacing a grey status dot that made a
                    ready button look inactive. */}
                <Play size={14} strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
                <strong>{sessionActionLabel}</strong>
              </>
            )}
          </button>
        </div>
      </div>

      <nav className="tab-bar" aria-label="Primary">
        {(['session', 'settings'] as const).map((item) => (
          <button
            className={tab === item ? 'is-selected' : ''}
            aria-current={tab === item ? 'page' : undefined}
            key={item}
            onClick={() => setTab(item)}
          >
            {item === 'session' ? 'Session' : 'Settings'}
          </button>
        ))}
      </nav>

      {notice && (
        <div className="notice" role="status">
          <AlertTriangle size={16} strokeWidth={2.25} aria-hidden="true" />
          <span>{notice}</span>
          {/* A real icon rather than the × character, which rendered at whatever
              weight the system font happened to give it. */}
          <button onClick={() => setNotice('')} aria-label="Dismiss">
            <X size={18} strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>
      )}

      {tab === 'session' && (
        <section className="panel-stack">
          {/* Shown only while something is outstanding, and never during a live
              session - mid-meeting is the wrong moment to be told about setup.
              On a fresh install this is the first thing on the page, because
              Start is otherwise the most prominent control on a window where
              pressing it cannot work. */}
          {!active && !readiness.allClear && (
            <article className="card readiness" aria-labelledby="readiness-heading">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">BEFORE YOU START</p>
                  <h2 id="readiness-heading">
                    {readiness.canStart
                      ? 'Ready, with one thing worth doing'
                      : 'One step left before captions can run'}
                  </h2>
                </div>
                {/* Offered only when everything left is advisory. A checklist you can
                    dismiss must never be the only explanation for a disabled Start
                    button, so a blocker cannot be skipped past. */}
                {readiness.canDismiss && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setAdvisoriesDismissed(true);
                      window.localStorage.setItem(READINESS_DISMISSED_KEY, '1');
                    }}
                  >
                    Not now
                  </button>
                )}
              </div>
              <ol className="readiness__list">
                {readiness.outstanding.map((step) => {
                  const StepIcon = READINESS_ICONS[step.id];
                  return (
                  <li
                    className={`readiness__step is-${step.severity}`}
                    key={step.id}
                  >
                    <span className="readiness__icon" aria-hidden="true">
                      <StepIcon size={18} strokeWidth={2} />
                    </span>
                    <div>
                      <strong>{step.title}</strong>
                      <p>{step.detail}</p>
                    </div>
                    {step.action && (
                      <button
                        className={`button ${
                          step.severity === 'blocking'
                            ? 'button--primary'
                            : 'button--secondary'
                        }`}
                        disabled={busy}
                        onClick={() => resolveReadiness(step.id)}
                      >
                        {step.action}
                      </button>
                    )}
                  </li>
                  );
                })}
              </ol>
            </article>
          )}
          {meetingReview?.recording && (
            <article className="card meeting-review">
              <div className="meeting-review__body">
                <p className="eyebrow">
                  {reviewOrigin === 'recovered' ? 'UNFINISHED MEETING' : 'AFTER THE MEETING'}
                </p>
                {/* The heading now asks the question the card exists to ask. It used
                    to read "Meeting saved" - answering something nobody wondered
                    about while the actual decision hid in the body text. */}
                <h2>{reviewHeading}</h2>
                <p className="supporting-copy" aria-live="polite">{reviewCopy}</p>
                {pendingDecision && reviewFacts && (
                  // Deciding needs facts, and they were only ever in Settings as a
                  // generic "two one-hour tracks can use ~346 MB".
                  <p className="meeting-review__facts">{reviewFacts}</p>
                )}
                {meetingReview.sessionDir && (
                  <p className="meeting-review__path">{meetingReview.sessionDir}</p>
                )}
              </div>
              <div className="meeting-review__actions">
                {pendingDecision && (
                  <div className="button-row">
                    <button
                      className="button button--primary"
                      disabled={busy}
                      onClick={() => void keepMeetingAudio()}
                    >
                      Keep audio
                    </button>
                    {/* Two steps, inline rather than a modal. Deleting is permanent
                        with no undo, which is the one case that earns a confirmation -
                        but a dialog would break the flow, and this was previously the
                        most muted control on the card despite being the destructive
                        one. */}
                    {confirmDiscard ? (
                      <>
                        <button
                          className="button button--danger"
                          disabled={busy}
                          onClick={() => {
                            setConfirmDiscard(false);
                            void discardMeetingAudio();
                          }}
                        >
                          Delete permanently
                        </button>
                        <button
                          className="button button--quiet"
                          disabled={busy}
                          onClick={() => setConfirmDiscard(false)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="button button--danger-quiet"
                        disabled={busy}
                        onClick={() => setConfirmDiscard(true)}
                      >
                        Delete audio
                      </button>
                    )}
                  </div>
                )}
                {/* The rest of the backlog, asked about in the same prompt rather than
                    one launch at a time. Each row carries its own facts, because
                    "keep or delete" is not answerable for a meeting you cannot
                    identify. */}
                {undecided.length > 0 && (
                  <div className="backlog">
                    <p className="backlog__heading">
                      {undecided.length} earlier meeting
                      {undecided.length === 1 ? '' : 's'} also undecided
                    </p>
                    <ul className="backlog__list">
                      {undecided.map((entry) => (
                        <li className="backlog__row" key={entry.sessionId}>
                          <div>
                            <strong>
                              {entry.session?.startedAt
                                ? new Date(entry.session.startedAt).toLocaleString()
                                : entry.sessionId}
                            </strong>
                            <span>{buildReviewFacts(entry.session) || 'Audio recorded'}</span>
                          </div>
                          <div className="button-row">
                            <button
                              className="button button--secondary"
                              disabled={busy}
                              onClick={() =>
                                void applyAudioDecision('keep', entry.sessionId)
                              }
                            >
                              Keep
                            </button>
                            <button
                              className="button button--danger-quiet"
                              disabled={busy}
                              onClick={() =>
                                void applyAudioDecision('discard', entry.sessionId)
                              }
                            >
                              Delete
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="button-row">
                      <button
                        className="button button--quiet"
                        disabled={busy}
                        onClick={() => void decideAllAudio('keep')}
                      >
                        Keep all {allUndecided.length}
                      </button>
                      {/* Bulk deletion is the most destructive control in the app, so
                          it arms before it fires, like the single-meeting one. */}
                      {confirmDiscardAll ? (
                        <>
                          <button
                            className="button button--danger"
                            disabled={busy}
                            onClick={() => void decideAllAudio('discard')}
                          >
                            Delete all {allUndecided.length} permanently
                          </button>
                          <button
                            className="button button--quiet"
                            disabled={busy}
                            onClick={() => setConfirmDiscardAll(false)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="button button--danger-quiet"
                          disabled={busy}
                          onClick={() => setConfirmDiscardAll(true)}
                        >
                          Delete all
                        </button>
                      )}
                    </div>
                    <p className="field-note">
                      Only the five most recent undecided recordings keep their audio.
                      Older ones release the audio automatically; every transcript is
                      always kept.
                    </p>
                  </div>
                )}
                {meetingReview.sessionId && !undecided.length && (
                  // Navigation, not the decision. Kept visually subordinate so it
                  // stops competing with Keep and Delete in one flat row of four.
                  <div className="button-row meeting-review__secondary">
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void window.captions.exportMeetingRecord(meetingReview.sessionId!)}
                    >
                      Save a copy…
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void window.captions.revealMeetingRecord(meetingReview.sessionId!)}
                    >
                      Show in folder
                    </button>
                  </div>
                )}
              </div>
            </article>
          )}
          <div className="session-grid">
            <article className="card session-card">
              <div className="section-heading">
                <div><p className="eyebrow">CAPTURE</p><h2>Meeting audio</h2></div>
                <button className="text-button" disabled={active || busy} onClick={() => void grantAudioAccess()}>
                  {/* Named for what it now does. It only ever tested the
                      microphone while showing a meeting meter beside it, which
                      made a working loopback look dead. */}
                  {previewing ? 'Retest audio' : 'Test audio'}
                </button>
              </div>
              <label className="field">
                <span>Microphone</span>
                <select disabled={active} value={microphoneId} onChange={(event) => void selectMicrophone(event.target.value)}>
                  {devices.inputs.length === 0 && <option value="">Permission required</option>}
                  {devices.inputs.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}
                </select>
              </label>
              <div className="audio-row">
                <span>You / microphone</span>
                <Level value={active ? metrics.levels?.microphone : previewLevel} />
                <ChannelBadge health={microphoneHealth} />
              </div>
              <div className="audio-row">
                <span>Meeting / system</span>
                <Level value={active ? metrics.levels?.system : previewSystemLevel} />
                <ChannelBadge health={systemHealth} />
              </div>
              {!active && previewing && !previewSystemReady && (
                <p className="capture-warning" role="alert">
                  <AlertTriangle size={16} strokeWidth={2.25} aria-hidden="true" />
                  <span>
                    System audio is not being captured, so remote speech will not be
                    transcribed separately.
                  </span>
                </p>
              )}
              {captureWarning && (
                <p className="capture-warning" role="alert">
                  <AlertTriangle size={16} strokeWidth={2.25} aria-hidden="true" />
                  <span>{captureWarning}</span>
                </p>
              )}
              {active && (
                <p
                  className={`backup-status ${backupFailed ? 'is-failed' : backupDegraded ? 'is-degraded' : ''}`}
                  role={backupFailed || backupDegraded ? 'alert' : 'status'}
                >
                  {/* A shield reads as "your audio is being protected"; a warning
                      triangle reads as "it is not". The dot said neither. */}
                  {backupFailed || backupDegraded ? (
                    <AlertTriangle size={13} strokeWidth={2.5} aria-hidden="true" />
                  ) : (
                    <ShieldCheck size={13} strokeWidth={2.5} aria-hidden="true" />
                  )}
                  {backupLabel}
                </p>
              )}
              <p className="field-note">Use headphones to prevent the microphone from capturing meeting playback twice.</p>
            </article>

            <article className="card">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">AUDIENCE VIEW</p>
                  <h2>
                    {settings.outputMode === 'virtual-camera'
                      ? 'Camera stage'
                      : 'Lower thirds'}
                  </h2>
                </div>
                <button
                  className="text-button"
                  onClick={() => void toggleAudiencePreview()}
                >
                  {selectedPreviewVisible ? 'Hide preview' : 'Preview'}
                </button>
              </div>
              <div className="segmented output-mode" aria-label="Caption output">
                <button
                  aria-pressed={settings.outputMode === 'overlays'}
                  className={settings.outputMode === 'overlays' ? 'is-selected' : ''}
                  onClick={() => void switchOutputMode('overlays')}
                >
                  On-screen captions
                </button>
                <button
                  aria-pressed={settings.outputMode === 'virtual-camera'}
                  className={settings.outputMode === 'virtual-camera' ? 'is-selected' : ''}
                  onClick={() => void switchOutputMode('virtual-camera')}
                >
                  Virtual camera
                </button>
              </div>
              <div className="segmented" aria-label="Caption layout">
                <button
                  aria-pressed={settings.layout === 'stacked'}
                  className={settings.layout === 'stacked' ? 'is-selected' : ''}
                  onClick={() => void switchLayout('stacked')}
                >
                  Stacked
                </button>
                <button
                  aria-pressed={settings.layout === 'side-by-side'}
                  className={settings.layout === 'side-by-side' ? 'is-selected' : ''}
                  onClick={() => void switchLayout('side-by-side')}
                >
                  Side by side
                </button>
              </div>
              {settings.outputMode === 'virtual-camera' && (
                <div
                  className={`output-mode__note native-camera-note is-${nativeCameraHealth?.state || 'checking'}`}
                  role={nativeCameraHealth?.state === 'failed' ? 'alert' : 'status'}
                >
                  {/* Status only, no button. The camera used to be installable from
                      here AND from Settings, with different labels and different
                      copy in each — two answers to the same question. There are now
                      exactly two places to act, each with a distinct job: the
                      readiness checklist above (fix it before starting) and the
                      Settings card (manage it). Both say "Install camera". */}
                  <span>
                    {nativeCameraMessage}
                    {nativeCameraHealth?.installed === false && (
                      <small>
                        Or capture the Twinscript Camera Stage window in OBS, then start OBS Virtual Camera.
                      </small>
                    )}
                  </span>
                </div>
              )}
              <fieldset className="theme-picker">
                <legend>Caption theme</legend>
                <div className="theme-picker__grid">
                  {captionThemes.map((theme) => (
                    <button
                      type="button"
                      key={theme.id}
                      className={settings.captionTheme === theme.id ? 'is-selected' : ''}
                      aria-label={`${theme.label} theme`}
                      aria-pressed={settings.captionTheme === theme.id}
                      onClick={() => void saveSettings({ captionTheme: theme.id })}
                    >
                      <span className="theme-picker__pair" aria-hidden="true">
                        <i style={{ background: theme.surfaces.en.background }} />
                        <i style={{ background: theme.surfaces.zh.background }} />
                      </span>
                      <span>{theme.label}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <div
                className={`overlay-preview overlay-preview--${settings.layout}`}
                style={{
                  '--preview-en': selectedTheme.surfaces.en.background,
                  '--preview-zh': selectedTheme.surfaces.zh.background,
                  '--preview-en-text': selectedTheme.surfaces.en.primary,
                  '--preview-zh-text': selectedTheme.surfaces.zh.primary,
                } as CSSProperties}
              >
                <div className="preview-en"><span>ENGLISH</span>{latest ? targetText(latest.english, 'en') : 'English audience caption'}</div>
                <div className="preview-zh"><span>中文</span>{latest ? targetText(latest.chinese, 'zh') : '中文观众字幕'}</div>
              </div>
              <label className="field pace-control">
                <span className="pace-control__heading">
                  <span>Visible history</span>
                  <output>{settings.captionHistoryEntries} entries</output>
                </span>
                <input
                  type="range"
                  min="3"
                  max="10"
                  step="1"
                  value={settings.captionHistoryEntries}
                  aria-label="Visible history"
                  aria-valuetext={`${settings.captionHistoryEntries} complete entries`}
                  onChange={(event) =>
                    void saveSettings({
                      captionHistoryEntries: Number(event.target.value),
                    })
                  }
                />
                <span className="pace-control__scale" aria-hidden="true">
                  <span>3</span>
                  <span>10</span>
                </span>
                <span className="pace-control__note">
                  Fewer entries means larger text: the caption fills the space it has.
                </span>
              </label>
              {/* Moved here from Settings. It is the sibling of Visible history -
                  the two together decide how the audience reads the caption - and
                  it sits directly under the preview that shows the result. */}
              <label className="field pace-control">
                <span className="pace-control__heading">
                  <span>Caption size</span>
                  <output>{Math.round(settings.captionFontScale * 100)}%</output>
                </span>
                <input
                  type="range"
                  min="0.8"
                  max="1.4"
                  step="0.05"
                  value={settings.captionFontScale}
                  aria-label="Caption size"
                  aria-valuetext={`${Math.round(settings.captionFontScale * 100)} percent`}
                  onChange={(event) =>
                    void saveSettings({
                      captionFontScale: Number(event.target.value),
                    })
                  }
                />
                <span className="pace-control__scale" aria-hidden="true">
                  <span>80%</span>
                  <span>140%</span>
                </span>
              </label>
            </article>
          </div>

          {captions.length > 0 && (
            <article className="card transcript-card">
              <div className="section-heading"><div><p className="eyebrow">SESSION LOG</p><h2>Latest captions</h2></div><span>{captions.length} lines</span></div>
              <div className="transcript-list">
                {[...captions].reverse().slice(0, 5).map((caption) => (
                  <div className="transcript-entry" key={caption.id}>
                    <header>
                      {caption.sourceChannel === 'microphone'
                        ? 'YOU · MICROPHONE'
                        : 'MEETING · SYSTEM AUDIO'}
                    </header>
                    <section>
                      <span>
                        {`ORIGINAL · ${
                          caption.sourceLanguage === 'en'
                            ? 'ENGLISH'
                            : caption.sourceLanguage === 'zh'
                              ? 'CHINESE'
                              : caption.sourceLanguage.toUpperCase()
                        }`}
                      </span>
                      <p>{caption.sourceText}</p>
                    </section>
                    <section>
                      <span>ENGLISH VIEW</span>
                      <p>{targetText(caption.english, 'en')}</p>
                    </section>
                    <section>
                      <span>中文视图</span>
                      <p lang="zh-Hans">{targetText(caption.chinese, 'zh')}</p>
                    </section>
                  </div>
                ))}
              </div>
              {/* Saving the log lives with the log. Previously in Settings, a tab
                  away from the thing it acts on. */}
              <div className="button-row transcript-actions">
                <button
                  className="button button--secondary"
                  onClick={() => void window.captions.exportSession('markdown')}
                >
                  Save readable transcript
                </button>
                <button
                  className="button button--quiet"
                  onClick={() => void window.captions.exportSession('json')}
                >
                  Save JSON
                </button>
              </div>
            </article>
          )}
        </section>
      )}

      {tab === 'settings' && (
        <section className="settings-layout">
          <article className="card">
            <p className="eyebrow">APPEARANCE</p><h2>Day and night</h2>
            <p className="supporting-copy">
              The control window only. Caption overlays and the camera stage keep the
              caption theme you chose for your audience.
            </p>
            {/* System is the default and stays offered, rather than being replaced by
                a two-way switch: an operator who has set their whole machine to shift
                at sunset should not have to set this one too. */}
            <div className="segmented segmented--triple" aria-label="Appearance">
              {(
                [
                  ['system', 'System', Monitor],
                  ['light', 'Light', Sun],
                  ['dark', 'Dark', Moon],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  aria-pressed={theme === value}
                  className={theme === value ? 'is-selected' : ''}
                  onClick={() => {
                    setTheme(value);
                    window.localStorage.setItem(THEME_STORAGE_KEY, value);
                  }}
                >
                  <Icon size={14} strokeWidth={2.25} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </article>

          {/* "Not now" persists, so without this the checklist could be dismissed once and
              never seen again - including by the next person to use the machine, and
              including after a reinstall of the camera changed what the advice should say.
              A dismissible thing needs a way back.

              The card reports three states and only offers navigation when there is
              somewhere to go. It previously said "Go to the checklist" unconditionally, so
              with everything already satisfied it switched tabs and showed nothing - a
              button that promised something it could not deliver. */}
          <article className="card">
            <p className="eyebrow">GETTING STARTED</p><h2>Setup checklist</h2>
            <p className="supporting-copy">
              {advisoriesDismissed
                ? checklistHasItems
                  ? `Hidden. ${checklistItemCount} item${checklistItemCount === 1 ? '' : 's'} would be shown before your next meeting.`
                  : 'Hidden. Nothing needs attention right now, but it will stay hidden when something does.'
                : checklistHasItems
                  ? `${checklistItemCount} item${checklistItemCount === 1 ? '' : 's'} to look at on the Session tab.`
                  : 'Nothing outstanding. It appears on the Session tab by itself whenever something needed for a meeting is missing.'}
            </p>
            {(advisoriesDismissed || checklistHasItems) && (
              <div className="button-row">
                <button
                  className={`button ${advisoriesDismissed ? 'button--primary' : 'button--secondary'}`}
                  disabled={busy}
                  onClick={() => {
                    if (advisoriesDismissed) {
                      setAdvisoriesDismissed(false);
                      window.localStorage.removeItem(READINESS_DISMISSED_KEY);
                    }
                    // Only switch tabs when the checklist will actually be there. Otherwise
                    // say what changed and stay put, rather than sending the operator to
                    // look at nothing.
                    if (checklistHasItems) setTab('session');
                    else setNotice('Checklist restored. It will appear when something needs attention.');
                  }}
                >
                  <ListChecks size={15} strokeWidth={2.25} aria-hidden="true" />
                  {advisoriesDismissed ? 'Show the checklist again' : 'Go to the checklist'}
                </button>
              </div>
            )}
            {/* Two scopes, side by side, weighted by consequence: the appearance reset is
                outlined, the full reset is solid, so the one that can discard a glossary is
                the one that looks like it.

                One `pendingReset` rather than a flag each. Two flags could both be true, and
                the card would then show two confirmation rows for two different resets. */}
            <div className="button-row">
              {pendingReset ? (
                <>
                  <button
                    className="button button--danger"
                    disabled={busy}
                    onClick={() => {
                      if (pendingReset === 'all') {
                        void resetEverySetting();
                        return;
                      }
                      const cleared = resetLocalPreferences(window.localStorage);
                      setAdvisoriesDismissed(false);
                      setTheme('system');
                      setPendingReset(null);
                      setNotice(
                        cleared.length
                          ? 'Appearance reset. Your key, glossary and meetings are unchanged.'
                          : 'Nothing to reset: appearance was already at its defaults.',
                      );
                    }}
                  >
                    {pendingReset === 'all'
                      ? 'Yes, reset everything'
                      : 'Yes, reset appearance'}
                  </button>
                  <button
                    className="button button--quiet"
                    disabled={busy}
                    onClick={() => setPendingReset(null)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="button button--danger-quiet"
                    disabled={busy}
                    onClick={() => setPendingReset('appearance')}
                  >
                    <RotateCcw size={15} strokeWidth={2.25} aria-hidden="true" />
                    Reset appearance
                  </button>
                  <button
                    className="button button--danger"
                    disabled={busy}
                    onClick={() => setPendingReset('all')}
                  >
                    <RotateCcw size={15} strokeWidth={2.25} aria-hidden="true" />
                    Reset all settings
                  </button>
                </>
              )}
            </div>
            {/* The note answers whichever question is live, so the consequence is on screen
                at the moment of the decision rather than above it. */}
            <p className="field-note">
              {pendingReset === 'all'
                ? 'This discards your custom glossary terms, protected codes and meeting context, and returns quality, budget, caption theme and record settings to their defaults.'
                : pendingReset === 'appearance'
                  ? "This clears this window's theme and checklist state. Nothing else changes."
                  : 'Appearance covers theme and checklist state. All settings also returns quality, budget, caption theme, records policy and your custom glossary to their defaults.'}
              {' '}
              Your API key and saved meetings are never touched.
            </p>
          </article>

          <article className="card pipeline-card">
            <p className="eyebrow">PROCESSING ROUTE</p><h2>Meeting pipeline</h2>
            <p className="supporting-copy">
              Choose transcription and final translation independently. These choices are locked when a meeting starts.
            </p>
            <div className="pipeline-choice">
              <div className="pipeline-choice__heading">
                <strong>Transcription model</strong>
                <span>{settings.transcriptionModel === 'whisper-local'
                  ? whisperLocalReady
                    ? `${localModels?.models['whisper-small'].actualDevice || localModels?.runtime.requestedDevice || 'CPU'} ready`
                    : localModels ? 'Model not installed' : 'Checking local model'
                  : 'Cloud live transcription'}</span>
              </div>
              <div className="model-switch-row">
                <span className={settings.transcriptionModel === 'openai-live' ? 'is-selected' : ''}>OpenAI live</span>
                <label className="model-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Use local Whisper transcription"
                    disabled={active}
                    checked={settings.transcriptionModel === 'whisper-local'}
                    onChange={(event) => void saveSettings({
                      transcriptionModel: event.target.checked ? 'whisper-local' : 'openai-live',
                    })}
                  />
                  <i aria-hidden="true" />
                </label>
                <span className={settings.transcriptionModel === 'whisper-local' ? 'is-selected' : ''}>Whisper local</span>
              </div>
            </div>
            <div className="pipeline-choice">
              <div className="pipeline-choice__heading">
                <strong>Final translation model</strong>
                <span>{settings.finalTranslationModel === 'hy-mt2-local'
                  ? translationLocalReady
                    ? `${localModels?.models['hy-mt2-1.8b'].actualDevice || 'CPU'} ready`
                    : localModels ? 'Model not installed' : 'Checking local model'
                  : 'Luna is authoritative'}</span>
              </div>
              <div className="model-switch-row">
                <span className={settings.finalTranslationModel === 'luna' ? 'is-selected' : ''}>Luna</span>
                <label className="model-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Use local Hy-MT2 for final translation"
                    disabled={active}
                    checked={settings.finalTranslationModel === 'hy-mt2-local'}
                    onChange={(event) => void saveSettings({
                      finalTranslationModel: event.target.checked ? 'hy-mt2-local' : 'luna',
                    })}
                  />
                  <i aria-hidden="true" />
                </label>
                <span className={settings.finalTranslationModel === 'hy-mt2-local' ? 'is-selected' : ''}>Hy-MT2 local</span>
              </div>
            </div>
            <label className="toggle pipeline-acceleration">
              <input
                type="checkbox"
                disabled={active}
                checked={settings.localTranslationAcceleration}
                onChange={(event) => void saveSettings({ localTranslationAcceleration: event.target.checked })}
              />
              <span>Use local Hy-MT2 for early translation</span>
            </label>
            <p className="field-note">
              Early local text is provisional. Your final translation model above always decides the saved caption.
              {!settings.provisionalTranslation && ' Early captions are currently turned off below.'}
            </p>
            {(settings.transcriptionModel === 'whisper-local' ||
              settings.finalTranslationModel === 'hy-mt2-local' ||
              settings.localTranslationAcceleration) && (
              <div className="local-model-readiness" aria-label="Local model readiness">
                {settings.transcriptionModel === 'whisper-local' && (
                  <span className={whisperLocalReady ? 'is-ready' : 'is-missing'}>
                    <i aria-hidden="true" />
                    Whisper {localModels ? (whisperLocalReady ? 'ready' : 'not installed') : 'checking'}
                  </span>
                )}
                {(settings.finalTranslationModel === 'hy-mt2-local' || settings.localTranslationAcceleration) && (
                  <span className={translationLocalReady ? 'is-ready' : 'is-missing'}>
                    <i aria-hidden="true" />
                    Hy-MT2 {localModels ? (translationLocalReady ? 'ready' : 'not installed') : 'checking'}
                  </span>
                )}
                {whisperMissing && (
                  <button className="button button--quiet" type="button" onClick={() => focusLocalModel('whisper-small')}>
                    Manage Whisper
                  </button>
                )}
                {translationMissing && (
                  <button className="button button--quiet" type="button" onClick={() => focusLocalModel('hy-mt2-1.8b')}>
                    Manage HY-MT2
                  </button>
                )}
              </div>
            )}
            {(whisperMissing || translationMissing) && (
              <p className="field-note is-warning">A selected local model is unavailable. Twinscript will block meeting startup rather than switch to cloud.</p>
            )}
            <div className="pipeline-summary" aria-label="Selected meeting pipeline">
              <span>{settings.transcriptionModel === 'whisper-local' ? 'Whisper local' : 'OpenAI live'}</span>
              <i aria-hidden="true">→</i>
              <span>{settings.finalTranslationModel === 'hy-mt2-local' ? 'Hy-MT2 local' : 'Luna'}</span>
              {settings.transcriptionModel === 'whisper-local' && settings.finalTranslationModel === 'hy-mt2-local' && (
                <em>Fully local</em>
              )}
            </div>
          </article>

          <LocalModelInstallCard
            status={localModels}
            busyModel={busyModel}
            rowRefs={{
              'whisper-small': whisperModelRow,
              'hy-mt2-1.8b': translationModelRow,
            }}
            onAction={(action, modelId) => void runLocalModelAction(action, modelId)}
          />

          <article className="card">
            <p className="eyebrow">{usesCloudModels ? 'OPENAI' : 'CLOUD OPTION'}</p><h2>Connection</h2>
            <p className="supporting-copy">
              {settings.transcriptionModel === 'openai-live' || settings.finalTranslationModel === 'luna'
                ? 'Your selected pipeline uses an OpenAI model. The API key is stored securely by this computer and is never shown after saving.'
                : 'Your selected pipeline is fully local. No API key is read when a meeting starts.'}
            </p>
            {(credentialIssue || credential?.repairRecommended) && (
              <div className="credential-recovery" role="alert">
                <div>
                  <strong>Saved key is locked</strong>
                  <p>Repair only this app’s credential storage, then add the API key again.</p>
                </div>
                <button
                  className="button button--secondary"
                  disabled={busy}
                  onClick={() => void repairCredential()}
                >
                  Repair secure storage
                </button>
              </div>
            )}
            <label className="field"><span>{credential?.available ? 'Replace API key' : usesCloudModels ? 'API key' : 'API key (optional)'}</span><input ref={apiKeyInput} type="password" autoComplete="off" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} placeholder="sk-…" /></label>
            <div className="button-row">
              <button className="button button--primary" disabled={busy || !keyInput.trim()} onClick={() => void saveKey()}>Validate & save</button>
              {credential?.available && <button className="button button--secondary" disabled={busy} onClick={() => void testSavedKey()}>Test saved key</button>}
              {credential?.source === 'secure-storage' && <button className="button button--quiet" disabled={busy} onClick={() => void window.captions.deleteCredential().then((result) => { if (result.ok) { setCredential(result.data); setCredentialIssue(false); } })}>Remove saved key</button>}
            </div>
          </article>

          <article className="card">
            <p className="eyebrow">CAPTION QUALITY</p><h2>Translation</h2>
            <label className="field"><span>Quality level</span><select disabled={active} value={settings.primaryProfile} onChange={(event) => void saveSettings({ primaryProfile: event.target.value as CaptionSettings['primaryProfile'] })}><option value="economy">Economy · lower cost</option><option value="tiered">Recommended · balanced</option><option value="quality">Best quality · higher cost</option></select></label>
            <label className="field"><span>Session budget cap (USD)</span><input type="number" min="0.5" max="50" step="0.5" value={settings.budgetUsd} onChange={(event) => void saveSettings({ budgetUsd: Number(event.target.value) })} /></label>
          </article>

          <article className="card">
            {/* Was "Timing and text". Caption size moved to the Audience view card
                beside Visible history, so nothing here concerns text any more. */}
            <p className="eyebrow">CAPTION DISPLAY</p><h2>Caption timing</h2>
            {/* Also snapshotted at session start - the session manager reads
                `this.settings.provisionalTranslation`, and that object is captured in
                start() and never refreshed. It was interactive mid-meeting and did
                nothing. */}
            <label className="toggle"><input type="checkbox" disabled={active} checked={settings.provisionalTranslation} onChange={(event) => void saveSettings({ provisionalTranslation: event.target.checked })} /><span>Show early captions while speech is processing</span></label>
            {/* A slider with the cost written down, not a dropdown of adjectives. As a
                "Fastest / Fast / Stable" select it named no consequence, so the rational
                choice was always Fastest - and the words most often corrected afterwards
                are part numbers, dimensions and names, which is most of what this app is
                listening to. */}
            <label className="field pace-control">
              <span className="pace-control__heading">
                <span>Caption responsiveness</span>
                <output>{delaySelection.label}</output>
              </span>
              {/* Disabled while live, like Quality level above it. The value is sent once,
                  in the session.update that opens the transcription socket, and is never
                  re-sent - so dragging this mid-meeting changed the stored setting and
                  nothing else. A control that moves and does nothing is worse than one that
                  is plainly unavailable. */}
              <input
                type="range"
                min="0"
                max={DELAY_OPTIONS.length - 1}
                step="1"
                disabled={active}
                value={delayIndex(settings.delayProfile)}
                aria-label="Caption responsiveness"
                aria-valuetext={`${delaySelection.label}. ${delaySelection.detail}`}
                onChange={(event) =>
                  void saveSettings({
                    delayProfile: delayProfileAt(
                      Number(event.target.value),
                    ) as CaptionSettings['delayProfile'],
                  })
                }
              />
              <span className="pace-control__scale" aria-hidden="true">
                <span>Sooner</span>
                <span>Fewer corrections</span>
              </span>
              <span className="pace-control__note">
                {delaySelection.detail}
                {active
                  ? ' Locked while a session is running: the transcriber is told this once, when the session starts. Stop and start to change it.'
                  : ' Applies when you start the next session.'}
              </span>
            </label>
            {/* Caption size lived here, one tab away from Visible history - its
                sibling control, affecting the same pixels. Both now sit in the
                Audience view card, beside the preview that shows what they do. */}
          </article>

          <article className="card glossary-card">
            <p className="eyebrow">ENGINEERING TERMS</p><h2>Engineering glossary</h2>
            <p className="supporting-copy">One built-in vocabulary covers mechanical design, manufacturing, quality, tooling, and supplier meetings. Product-development tokens such as T1, T2, EVT, DVT, and PVT stay in English in both captions.</p>
            <div className="glossary-summary">
              <p>Ready for engineering conversations without choosing a meeting type.</p>
              <p className="glossary-count">
                <strong>{universalGlossary?.termCount ?? settings.glossaryStoredCount} built-in terms</strong>
                {' · '}
                {settings.protectedTokens.length} protected tokens
              </p>
            </div>
            <div className="button-row">
              <button className="button button--secondary" disabled={active || busy} onClick={() => void importGlossary()}>Import glossary</button>
              <button className="button button--quiet" disabled={busy} onClick={() => void exportGlossary()}>Export configuration</button>
            </div>
            <p className="field-note">Import is processed locally. Only active terms are supplied to the selected translation engine while a live session is running.</p>

            {/* The viewer. The card previously reported "138 built-in terms" and nothing
                else, so there was no way to check whether a term was already covered,
                what its built-in Chinese rendering was, or whether an override had taken
                effect. Search covers both columns: an operator checking a supplier's
                term usually has the Chinese in front of them. */}
            <div className="glossary-browser">
              <label className="field">
                <span>Search the glossary</span>
                <input
                  type="search"
                  value={glossaryQuery}
                  placeholder="boss, 壁厚, EVT…"
                  onChange={(event) => setGlossaryQuery(event.target.value)}
                />
              </label>
              {effectiveGlossary ? (
                <>
                  <ul className="glossary-list">
                    {glossaryMatches.visible.map((term) => (
                      <li
                        key={`${term.source}-${term.en}`}
                        className={term.active ? '' : 'is-inactive'}
                      >
                        <span className="glossary-list__en">{term.en}</span>
                        <span className="glossary-list__zh" lang="zh-Hans">
                          {term.doNotTranslate ? 'kept in English' : term.zh}
                        </span>
                        <span className="glossary-list__marks">
                          {term.source === 'custom' && (
                            <span className="glossary-list__tag">YOURS</span>
                          )}
                          {/* Stored but past the cap, so it never reaches the model. */}
                          {!term.active && (
                            <span className="glossary-list__tag is-muted">STORED</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {/* Two numbers that used to disagree in public: the card counted
                      STORED terms (138) while this list showed the ACTIVE subset (40).
                      Both were true and neither said so. The gap is real and worth
                      surfacing - terms past the cap never reach the model - so the list
                      now shows everything stored, marks what is sent, and says why. */}
                  <p className="glossary-count">
                    {glossaryMatches.matchCount === 0
                      ? 'No terms match. Add it below and it will apply to the next session.'
                      : `${glossaryMatches.matchCount} of ${effectiveGlossary.storedCount} terms${
                          glossaryMatches.truncated > 0
                            ? ` · showing ${glossaryMatches.visible.length}, narrow the search for the rest`
                            : ''
                        }`}
                  </p>
                  <p className="field-note">
                    The first {effectiveGlossary.activeLimit} terms are sent to the selected translation engine each
                    session; the rest stay stored. Your own entries sort ahead of built-in
                    ones.
                  </p>
                </>
              ) : (
                <p className="glossary-count">Loading the glossary…</p>
              )}
            </div>

            <details className="glossary-advanced">
              <summary>Edit your own terms, phrases and context</summary>
              <div className="glossary-advanced__body">
                <TermPairSection
                  drafts={pairDrafts}
                  disabled={active}
                  onChange={(id, patch) => updateDraft('pairs', id, patch)}
                  onRemove={(id) => removeDraft('pairs', id)}
                  onAdd={() => addDraft('pairs')}
                />
                <LiteralSection
                  drafts={literalDrafts}
                  disabled={active}
                  onChange={(id, patch) => updateDraft('literal', id, patch)}
                  onRemove={(id) => removeDraft('literal', id)}
                  onAdd={() => addDraft('literal')}
                />
                <TokenSection
                  value={protectedTokenText}
                  disabled={active}
                  onChange={setProtectedTokenText}
                />
                <ContextSection
                  entries={contextEntries}
                  disabled={active}
                  onChange={(index, value) =>
                    setContextEntries((current) =>
                      current.map((entry, i) => (i === index ? value : entry)),
                    )
                  }
                  onRemove={(index) =>
                    setContextEntries((current) => {
                      const next = current.filter((_, i) => i !== index);
                      return next.length ? next : [''];
                    })
                  }
                  onAdd={() => setContextEntries((current) => [...current, ''])}
                />
                <div className="button-row">
                  <button
                    className="button button--primary"
                    disabled={active || busy}
                    onClick={() => void saveGlossaryOverrides()}
                  >
                    Save changes
                  </button>
                </div>
                <p className="field-note">
                  Your entries take priority over the built-in glossary and apply to the
                  next session.
                </p>
              </div>
            </details>
          </article>

          <article className="card meeting-records-card">
            <p className="eyebrow">MEETING RECORDS</p>
            <h2>Meeting records</h2>
            <p className="supporting-copy">
              Microphone and meeting audio are temporarily recorded as separate encrypted tracks during every live session so you can decide after the meeting.
            </p>
            <label className="toggle">
              <input
                type="checkbox"
                disabled={active || busy}
                checked={settings.autoSaveTranscript}
                onChange={(event) =>
                  void saveSettings({ autoSaveTranscript: event.target.checked })
                }
              />
              <span>Auto-save transcript</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                disabled={active || busy}
                checked={settings.keepAudioAutomatically}
                onChange={(event) =>
                  void saveSettings({
                    keepAudioAutomatically: event.target.checked,
                  })
                }
              />
              <span>Keep audio automatically</span>
            </label>
            {/* Location and its actions read top to bottom: label, value, then the
                buttons that act on it. They used to sit in a space-between row that
                pushed them to the far right of the card, away from the path they
                belonged to and out of line with every other card's actions. */}
            <div className="record-location">
              <span>Save location</span>
              <strong>
                {settings.meetingRecordsDirectory || 'Documents\\Twinscript'}
              </strong>
              {/* What the recordings are actually costing, rather than only what a
                  hypothetical hour-long meeting would cost. */}
              <p className="record-usage">
                {recordsUsage
                  ? recordsUsage.sessionCount === 0
                    ? 'No meetings saved yet.'
                    : `${formatSize(recordsUsage.bytes)} across ${recordsUsage.sessionCount} meeting${
                        recordsUsage.sessionCount === 1 ? '' : 's'
                      }${
                        recordsUsage.pendingBytes > 0
                          ? `, including ${formatSize(recordsUsage.pendingBytes)} of audio still awaiting a decision`
                          : ''
                      }.`
                  : 'Measuring saved meetings…'}
              </p>
            </div>
            <div className="button-row">
              {/* Reaching the records folder previously required recording a meeting
                  and then using Show in folder on that one session. */}
              <button
                className="button button--secondary"
                disabled={busy}
                onClick={() => void window.captions.openMeetingRecordsFolder()}
              >
                <FolderOpen size={15} strokeWidth={2.25} aria-hidden="true" />
                Open folder
              </button>
              <button
                className="button button--quiet"
                disabled={active || busy}
                onClick={() => void chooseMeetingRecordsDirectory()}
              >
                Change location…
              </button>
            </div>
            <p className="field-note">
              A one-hour meeting keeps about 346 MB across both 24 kHz mono tracks.
            </p>
          </article>

          {/* Rendered whenever the platform could host the camera, NOT only when a
              health report has arrived saying so. Gating the whole card on
              `health.supported` meant that a missing or failed health report hid
              every action, leaving no way to install or repair the camera from the
              UI at all — which is exactly what happened. */}
          {cameraCardVisible && (
            <article className="card native-camera-card">
              <p className="eyebrow">WINDOWS VIRTUAL CAMERA</p>
              <div className="section-heading">
                <div>
                  <h2>Native virtual camera</h2>
                  <p className="supporting-copy">
                    Runs outside the caption process. If it stops, transcription and on-screen captions continue.
                  </p>
                </div>
                <span
                  className={`native-camera-state is-${nativeCameraHealth?.state || 'checking'}`}
                >
                  {nativeCameraHealth?.installed ? (
                    <Check size={11} strokeWidth={3} aria-hidden="true" />
                  ) : (
                    <Video size={11} strokeWidth={2.5} aria-hidden="true" />
                  )}
                  {(nativeCameraHealth?.state || 'checking').replace('-', ' ')}
                </span>
              </div>
              <p className="native-camera-detail">{nativeCameraMessage}</p>
              <div className="button-row">
                {/* Install is ALWAYS available, and is the same action as repair:
                    registering the filter is idempotent. Reinstalling is legitimate
                    at any time — after an app update, or when the registered file has
                    gone missing — so hiding it behind `!installed` left the operator
                    with a broken camera and no button. */}
                <button
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => void runNativeCameraAction('install')}
                >
                  {nativeCameraHealth?.installed
                    ? 'Reinstall camera'
                    : 'Install camera'}
                </button>
                {nativeCameraHealth?.installed && (
                  <button
                    className="button button--quiet"
                    disabled={busy}
                    onClick={() => void runNativeCameraAction('remove')}
                  >
                    Remove camera
                  </button>
                )}
              </div>
              <p className="field-note">
                Install, Repair, and Remove request Windows approval once for that action. Ordinary sessions do not require administrator access.
              </p>
            </article>
          )}

          {/* Last card on the page, deliberately. Attribution is something an
              operator looks up once - when filing a bug, or checking what this
              thing is built on - so it earns a fixed, findable home rather than a
              place in the flow of things they came here to change.

              The strings live in `aboutCredits.ts` so the version and the stack
              can be asserted against package.json instead of drifting into a
              claim nobody re-reads. */}
          <article className="card about-card" aria-labelledby="about-heading">
            <p className="eyebrow">ABOUT</p>
            <div className="about-card__identity">
              {/* The white plate carries its own 22.25% corner radius, so this
                  wrapper matches it rather than clipping to a radius of its own -
                  see TwinscriptLogo.tsx. */}
              <span className="brand-mark">
                <TwinscriptLogo size={52} />
              </span>
              <div>
                <h2 id="about-heading">
                  {APP_NAME}
                  <span lang="zh-Hans"> {APP_NAME_ZH}</span>
                </h2>
                <p className="about-card__version">
                  <span>Version {APP_VERSION}</span>
                  <span aria-hidden="true">·</span>
                  <a href={APP_LICENSE_URL} target="_blank" rel="noreferrer">
                    {APP_LICENSE}
                  </a>
                </p>
              </div>
            </div>
            <dl className="about-card__credits">
              {CREDITS.map((credit) => (
                <div className="about-card__credit" key={credit.label}>
                  <dt>{credit.label}</dt>
                  <dd>{credit.body}</dd>
                </div>
              ))}
            </dl>
            <p className="about-card__signature">{SIGNATURE}</p>
          </article>

          {/* "Save this meeting" was here, one tab away from both the log it saves
              and the post-meeting review card that also saves. Saving is a
              per-meeting action, not durable configuration, so it now sits on the
              Session tab under the transcript. Settings keeps only the policy:
              whether to auto-save, and where. */}
        </section>
      )}

      <footer className="app-footer">
        {/* Only while idle. During a session the stripe carries spend against budget, and
            two places showing the same figure is how they come to disagree. */}
        {!active && (
          <span>
            {usesCloudModels ? (
              <>Estimated session cost <strong>${sessionCost.toFixed(3)}</strong> / ${sessionBudget.toFixed(2)}</>
            ) : (
              <>Local pipeline <strong>no API inference cost</strong></>
            )}
          </span>
        )}
        <span>
          Temporary audio backup is encrypted; playable audio is created only after Keep.{' '}
          {/* The only menu item with no in-app equivalent, so it moves here rather
              than disappearing with the hidden menu bar. It also belongs next to the
              sentence about how this app handles audio. */}
          {usesCloudModels ? (
            <a
              href="https://developers.openai.com/api/docs/guides/your-data"
              target="_blank"
              rel="noreferrer"
            >
              OpenAI data controls
            </a>
          ) : (
            <span>Speech and translations stay on this computer.</span>
          )}
        </span>
      </footer>
    </main>
  );
}
