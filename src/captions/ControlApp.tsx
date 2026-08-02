import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AudioCaptureController,
  MicrophonePreviewController,
  enumerateAudioDevices,
  type AudioDeviceOption,
} from './audioCapture';
import { type ChannelHealth, deriveChannelHealth } from './captureHealth';
import { captionThemeById, captionThemes } from './captionThemes';
import type {
  CaptionEvent,
  GlossaryConfiguration,
  GlossaryConfigurationSummary,
  GlossaryTerm,
  CaptionSettings,
  BackupState,
  MeetingRecordReview,
  NativeCameraHealth,
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
  settingsVersion: 9,
  layout: 'stacked',
  outputMode: 'overlays',
  primaryProfile: 'economy',
  shadowProfile: 'tiered',
  shadowEnabled: false,
  fastPath: true,
  provisionalTranslation: true,
  vadEnabled: false,
  vadThreshold: 0.012,
  delayProfile: 'low',
  budgetUsd: 5,
  glossaryConfigurationId: 'universal-engineering',
  customGlossaryConfiguration: null,
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
  const width = `${Math.max(2, Math.min(100, value * 900))}%`;
  return <span className="level"><i style={{ width }} /></span>;
}

// A persistent per-channel badge. A dismissible notice is not enough: an
// operator must be able to look at the panel mid-meeting and see that the
// meeting channel is carrying nothing.
function ChannelBadge({ health }: { health: ChannelHealth }) {
  if (health.state === 'idle') return null;
  return (
    <span
      className={`channel-badge is-${health.state}`}
      title={health.detail}
      role={health.state === 'live' || health.state === 'waiting' ? undefined : 'alert'}
    >
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
  const [glossaryText, setGlossaryText] = useState('');
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
  const [captureStartedAt, setCaptureStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [previewing, setPreviewing] = useState(false);
  const [previewLevel, setPreviewLevel] = useState(0);
  const [previewVisibility, setPreviewVisibility] = useState({
    overlaysVisible: false,
    cameraStageVisible: false,
  });
  const [nativeCameraHealth, setNativeCameraHealth] =
    useState<NativeCameraHealth | null>(null);
  const audio = useRef(new AudioCaptureController());
  const microphonePreview = useRef(new MicrophonePreviewController());
  const apiKeyInput = useRef<HTMLInputElement>(null);
  const operationId = useRef(0);
  const active = sessionActive;

  useEffect(() => {
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
        if (records[0]) {
          setMeetingReview(records[0]);
          setReviewOrigin('recovered');
        }
      }),
      window.captions.onPreviewVisibility(setPreviewVisibility),
      window.captions.onNativeCameraHealth(setNativeCameraHealth),
    ];
    void window.captions.getPreviewVisibility().then((result) => {
      if (result.ok) setPreviewVisibility(result.data);
    });
    void window.captions.getNativeCameraHealth().then((result) => {
      if (result.ok) setNativeCameraHealth(result.data);
    });
    void Promise.all([
      window.captions.getSettings(),
      window.captions.getGlossaryConfigurations(),
      window.captions.credentialStatus(),
      window.captions.getSessionStatus(),
      window.captions.listPendingMeetingRecords(),
      enumerateAudioDevices().catch(() => ({ inputs: [], outputs: [] })),
    ]).then(([settingsResult, glossaryResult, credentialResult, sessionResult, pendingResult, deviceResult]) => {
      if (settingsResult.ok) {
        const next = settingsResult.data as unknown as CaptionSettings;
        setSettingsState(next);
        setGlossaryText(
          next.customGlossaryConfiguration?.terms
            .map((entry) => `${entry.en} = ${entry.zh}`)
            .join('\n') || '',
        );
        setProtectedTokenText(
          next.customGlossaryConfiguration?.protectedTokens.join(', ') || '',
        );
      }
      if (glossaryResult.ok) setGlossaryConfigurations(glossaryResult.data);
      if (credentialResult.ok) {
        setCredential(credentialResult.data);
        setCredentialIssue(Boolean(credentialResult.data.repairRecommended));
      }
      if (sessionResult.ok && sessionResult.data.active) {
        setSessionActive(true);
        setStatus({ state: 'running' });
      }
      if (pendingResult.ok && pendingResult.data[0]) {
        setMeetingReview(pendingResult.data[0]);
        setReviewOrigin('recovered');
      }
      setDevices(deviceResult);
      setMicrophoneId(deviceResult.inputs[0]?.deviceId || '');
    });
    return () => {
      cleanups.forEach((cleanup) => cleanup());
      void microphonePreview.current.stop();
      void audio.current.stop();
    };
  }, []);

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
    return next;
  };

  const switchOutputMode = async (
    outputMode: CaptionSettings['outputMode'],
  ) => {
    await saveSettings({ outputMode });
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

  const nativeCameraMessage = (() => {
    if (!nativeCameraHealth?.supported) {
      return 'Use OBS Virtual Camera on this system.';
    }
    if (!nativeCameraHealth.installed) {
      return 'Windows 11 native camera is not installed.';
    }
    if (nativeCameraHealth.state === 'repair-required') {
      return nativeCameraHealth.message || 'The installed camera must be repaired for this app version.';
    }
    if (nativeCameraHealth.state === 'streaming') {
      return 'Twinscript camera is running and ready to select in your meeting app.';
    }
    if (nativeCameraHealth.state === 'starting') {
      return 'Starting the Twinscript cameraâ€¦';
    }
    if (nativeCameraHealth.state === 'restarting') {
      return nativeCameraHealth.message || 'Camera stopped unexpectedly; restarting once.';
    }
    if (nativeCameraHealth.state === 'failed') {
      return nativeCameraHealth.message || 'Native camera needs attention. Captions remain active.';
    }
    return 'Native camera is installed. Select Virtual camera to start it.';
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

  const keepMeetingAudio = async () => {
    if (!meetingReview?.sessionId) return;
    setBusy(true);
    const result = await window.captions.keepMeetingAudio(meetingReview.sessionId);
    setBusy(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    setMeetingReview(result.data);
  };

  const discardMeetingAudio = async () => {
    if (!meetingReview?.sessionId) return;
    const confirmed = window.confirm(
      'Permanently discard both the microphone and meeting audio backup? This cannot be undone.',
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await window.captions.discardMeetingAudio(
      meetingReview.sessionId,
    );
    setBusy(false);
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    setMeetingReview(result.data);
  };

  const grantAudioAccess = async () => {
    setBusy(true);
    setNotice('');
    try {
      await microphonePreview.current.stop();
      setPreviewing(false);
      setPreviewLevel(0);
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
      await microphonePreview.current.start(selected, setPreviewLevel);
      setPreviewing(true);
      setNotice('Microphone is active. Speak now—the input meter should respond.');
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
      await microphonePreview.current.start(deviceId || undefined, setPreviewLevel);
    } catch (error) {
      setPreviewing(false);
      setPreviewLevel(0);
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

  const parseGlossary = (): GlossaryTerm[] =>
    glossaryText
      .split('\n')
      .map((line) => line.split(/=|→/).map((value) => value.trim()))
      .filter(([en, zh]) => en && zh)
      .map(([en, zh]) => ({
        en,
        zh,
        aliases: [],
        doNotTranslate: false,
        priority: 5,
      }));

  const parseProtectedTokens = () =>
    protectedTokenText
      .split(/[,\n;]/)
      .map((token) => token.trim())
      .filter(Boolean);

  const syncGlossaryEditors = (next: CaptionSettings) => {
    setGlossaryText(
      next.customGlossaryConfiguration?.terms
        .map((entry) => `${entry.en} = ${entry.zh}`)
        .join('\n') || '',
    );
    setProtectedTokenText(
      next.customGlossaryConfiguration?.protectedTokens.join(', ') || '',
    );
  };

  const saveGlossaryOverrides = async () => {
    const terms = parseGlossary();
    const protectedTokens = parseProtectedTokens();
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
    const next = await saveSettings({ customGlossaryConfiguration });
    if (!next) return;
    syncGlossaryEditors(next);
    setNotice(
      customGlossaryConfiguration
        ? 'Custom glossary overrides saved.'
        : 'Custom glossary overrides cleared.',
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

  const latest = useMemo(
    () =>
      [...captions].reverse().find((caption) => caption.status === 'final') ||
      captions[captions.length - 1],
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
  const selectedTheme = captionThemeById(settings.captionTheme);

  const sessionActionLabel =
    operation === 'stopping'
      ? 'Stopping…'
      : active
        ? 'Stop session'
        : 'Start session';
  const sessionActionDisabled =
    operation === 'stopping' ||
    (!active &&
      (busy || !credential?.available || Boolean(pendingDecision)));

  return (
    <main className="control-shell">
      <header className="app-header">
        <div>
          {/* The Chinese name sits in the operator UI rather than the audience
              overlays: the camera stage and lower thirds must stay free of
              branding (see docs/windows/virtual-camera.md). */}
          <p className="eyebrow">TWINSCRIPT<span lang="zh-Hans"> 会意</span></p>
          <h1>Live Caption Studio</h1>
        </div>
        <button
          type="button"
          className={`session-pill session-action ${active ? 'is-live' : ''}`}
          disabled={sessionActionDisabled}
          onClick={() => void (active ? stop() : start())}
        >
          <i aria-hidden="true" />
          <strong>{sessionActionLabel}</strong>
          {active && (
            <>
              <span className="session-pill__separator" aria-hidden="true">|</span>
              <span className="session-pill__timer">
                {formatElapsed(metrics.elapsedMs)}
              </span>
            </>
          )}
        </button>
      </header>

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

      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}

      {tab === 'session' && (
        <section className="panel-stack">
          {meetingReview?.recording && (
            <article className="card meeting-review" aria-live="polite">
              <div>
                <p className="eyebrow">
                  {reviewOrigin === 'recovered' ? 'RECOVERY REQUIRED' : 'MEETING RECORD'}
                </p>
                <h2>
                  {reviewOrigin === 'recovered' ? 'Recovered meeting' : 'Meeting saved'}
                </h2>
                <p className="supporting-copy">
                  {meetingReview.session?.audioRetention === 'pending'
                    ? 'The transcript is saved. Choose whether to keep or permanently discard the encrypted microphone and meeting audio backup.'
                    : meetingReview.session?.audioRetention === 'kept'
                      ? 'Audio backup kept as separate microphone and meeting WAV files.'
                      : meetingReview.session?.audioRetention === 'discarded'
                        ? 'Encrypted microphone and meeting audio backup discarded.'
                        : 'The transcript is saved. Audio backup was unavailable for this meeting.'}
                </p>
                {meetingReview.sessionDir && (
                  <p className="meeting-review__path">{meetingReview.sessionDir}</p>
                )}
              </div>
              <div className="button-row">
                {pendingDecision && (
                  <>
                    <button
                      className="button button--primary"
                      disabled={busy}
                      onClick={() => void keepMeetingAudio()}
                    >
                      Keep audio backup
                    </button>
                    <button
                      className="button button--quiet"
                      disabled={busy}
                      onClick={() => void discardMeetingAudio()}
                    >
                      Discard audio
                    </button>
                  </>
                )}
                {meetingReview.sessionId && (
                  <>
                    <button
                      className="button button--secondary"
                      disabled={busy}
                      onClick={() => void window.captions.exportMeetingRecord(meetingReview.sessionId!)}
                    >
                      Save a copy…
                    </button>
                    <button
                      className="button button--quiet"
                      disabled={busy}
                      onClick={() => void window.captions.revealMeetingRecord(meetingReview.sessionId!)}
                    >
                      Show in folder
                    </button>
                  </>
                )}
              </div>
            </article>
          )}
          <div className="session-grid">
            <article className="card session-card">
              <div className="section-heading">
                <div><p className="eyebrow">CAPTURE</p><h2>Meeting audio</h2></div>
                <button className="text-button" disabled={active || busy} onClick={() => void grantAudioAccess()}>
                  {previewing ? 'Retest microphone' : 'Test microphone'}
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
                <Level value={metrics.levels?.system} />
                <ChannelBadge health={systemHealth} />
              </div>
              {captureWarning && (
                <p className="capture-warning" role="alert">{captureWarning}</p>
              )}
              {active && (
                <p
                  className={`backup-status ${backupFailed ? 'is-failed' : backupDegraded ? 'is-degraded' : ''}`}
                  role={backupFailed || backupDegraded ? 'alert' : 'status'}
                >
                  <i aria-hidden="true" />
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
              {settings.outputMode === 'virtual-camera' ? (
                <div
                  className={`output-mode__note native-camera-note is-${nativeCameraHealth?.state || 'checking'}`}
                  role={nativeCameraHealth?.state === 'failed' ? 'alert' : 'status'}
                >
                  <span>{nativeCameraMessage}</span>
                  {nativeCameraHealth?.supported && !nativeCameraHealth.installed && (
                    <button
                      className="button button--secondary"
                      disabled={busy}
                      onClick={() => void runNativeCameraAction('install')}
                    >
                      Install native camera
                    </button>
                  )}
                  {(!nativeCameraHealth?.supported || !nativeCameraHealth?.installed) && (
                    <small>
                      Or capture the Bilingual Camera Stage window in OBS, then start OBS Virtual Camera.
                    </small>
                  )}
                </div>
              ) : (
                <div className="segmented">
                  <button className={settings.layout === 'stacked' ? 'is-selected' : ''} onClick={() => void saveSettings({ layout: 'stacked' })}>Stacked</button>
                  <button className={settings.layout === 'side-by-side' ? 'is-selected' : ''} onClick={() => void saveSettings({ layout: 'side-by-side' })}>Side by side</button>
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
                  Keep complete caption entries visible for audience context.
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
            </article>
          )}
        </section>
      )}

      {tab === 'settings' && (
        <section className="settings-layout">
          <article className="card">
            <p className="eyebrow">OPENAI</p><h2>Connection</h2>
            <p className="supporting-copy">Your API key is stored securely by this computer and is never shown after saving.</p>
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
            <label className="field"><span>{credential?.available ? 'Replace API key' : 'API key'}</span><input ref={apiKeyInput} type="password" autoComplete="off" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} placeholder="sk-…" /></label>
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
            <p className="eyebrow">CAPTION DISPLAY</p><h2>Timing and text</h2>
            <label className="toggle"><input type="checkbox" checked={settings.provisionalTranslation} onChange={(event) => void saveSettings({ provisionalTranslation: event.target.checked })} /><span>Show early captions while speech is processing</span></label>
            <label className="field"><span>Caption responsiveness</span><select value={settings.delayProfile} onChange={(event) => void saveSettings({ delayProfile: event.target.value as CaptionSettings['delayProfile'] })}><option value="minimal">Fastest</option><option value="low">Fast</option><option value="default">Stable</option></select></label>
            <label className="field"><span>Caption size · {Math.round(settings.captionFontScale * 100)}%</span><input type="range" min="0.8" max="1.4" step="0.05" value={settings.captionFontScale} onChange={(event) => void saveSettings({ captionFontScale: Number(event.target.value) })} /></label>
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
            <div className="button-row glossary-actions">
              <button className="button button--secondary" disabled={active || busy} onClick={() => void importGlossary()}>Import glossary</button>
              <button className="button button--quiet" disabled={busy} onClick={() => void exportGlossary()}>Export configuration</button>
            </div>
            <p className="field-note">Import is processed locally. Only active terms are supplied to OpenAI while a live session is running.</p>
            <details className="glossary-advanced">
              <summary>Advanced · Custom terms and protected tokens</summary>
              <div className="glossary-advanced__body">
                <div className="field">
                  <label htmlFor="custom-glossary-terms">Custom bilingual overrides</label>
                  <textarea
                    id="custom-glossary-terms"
                    rows={7}
                    disabled={active}
                    value={glossaryText}
                    onChange={(event) => setGlossaryText(event.target.value)}
                    placeholder={'boss = 凸台\nwall thickness = 壁厚'}
                    aria-describedby="custom-glossary-terms-note"
                  />
                  <span id="custom-glossary-terms-note" className="field-note">One pair per line. Custom rows take priority over the built-in engineering glossary.</span>
                </div>
                <div className="field">
                  <label htmlFor="custom-protected-tokens">Additional protected tokens</label>
                  <input
                    id="custom-protected-tokens"
                    type="text"
                    disabled={active}
                    value={protectedTokenText}
                    onChange={(event) => setProtectedTokenText(event.target.value)}
                    placeholder="Project Falcon, ABC-123, Gate 4"
                    aria-describedby="custom-protected-tokens-note"
                  />
                  <span id="custom-protected-tokens-note" className="field-note">Separate with commas. These tokens remain literal in both languages.</span>
                </div>
                <button className="button button--secondary" disabled={active || busy} onClick={() => void saveGlossaryOverrides()}>Save custom overrides</button>
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
            <div className="record-location">
              <div>
                <span>Save location</span>
                <strong>
                  {settings.meetingRecordsDirectory ||
                    'Documents\\Twinscript'}
                </strong>
              </div>
              <button
                className="button button--secondary"
                disabled={active || busy}
                onClick={() => void chooseMeetingRecordsDirectory()}
              >
                Choose folder…
              </button>
            </div>
            <p className="field-note">
              Two retained one-hour, 24 kHz mono WAV tracks can use approximately 346 MB.
            </p>
          </article>

          {nativeCameraHealth?.supported && (
            <article className="card native-camera-card">
              <p className="eyebrow">WINDOWS 11 CAMERA</p>
              <div className="section-heading">
                <div>
                  <h2>Native virtual camera</h2>
                  <p className="supporting-copy">
                    Runs outside the caption process. If it stops, transcription and on-screen captions continue.
                  </p>
                </div>
                <span className={`native-camera-state is-${nativeCameraHealth.state}`}>
                  {nativeCameraHealth.state.replace('-', ' ')}
                </span>
              </div>
              <p className="native-camera-detail">{nativeCameraMessage}</p>
              <div className="button-row">
                {!nativeCameraHealth.installed ? (
                  <button
                    className="button button--primary"
                    disabled={busy}
                    onClick={() => void runNativeCameraAction('install')}
                  >
                    Install native camera
                  </button>
                ) : (
                  <>
                    {nativeCameraHealth.state === 'failed' && (
                      <button
                        className="button button--primary"
                        disabled={busy}
                        onClick={() => void runNativeCameraAction('retry')}
                      >
                        Retry camera
                      </button>
                    )}
                    <button
                      className="button button--secondary"
                      disabled={busy}
                      onClick={() => void runNativeCameraAction('repair')}
                    >
                      Repair camera
                    </button>
                    <button
                      className="button button--quiet"
                      disabled={busy}
                      onClick={() => void runNativeCameraAction('remove')}
                    >
                      Remove camera
                    </button>
                  </>
                )}
              </div>
              <p className="field-note">
                Install, Repair, and Remove request Windows approval once for that action. Ordinary sessions do not require administrator access.
              </p>
            </article>
          )}

          <article className="card export-card">
            <p className="eyebrow">SESSION TRANSCRIPT</p><h2>Save this meeting</h2>
            <p className="supporting-copy">Save a copy of the current bilingual captions, timing, and estimated cost.</p>
            <div className="button-row"><button className="button button--secondary" onClick={() => void window.captions.exportSession('json')}>Save JSON</button><button className="button button--quiet" onClick={() => void window.captions.exportSession('markdown')}>Save readable transcript</button></div>
          </article>
        </section>
      )}

      <footer className="app-footer">
        <span>Estimated session cost <strong>${(metrics.totalUsd || 0).toFixed(3)}</strong> / ${(settings.budgetUsd || 0).toFixed(2)}</span>
        <span>Temporary audio backup is encrypted; playable audio is created only after Keep.</span>
      </footer>
    </main>
  );
}
