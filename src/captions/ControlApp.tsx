import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioCaptureController,
  MicrophonePreviewController,
  enumerateAudioDevices,
  type AudioDeviceOption,
} from './audioCapture';
import type {
  CaptionEvent,
  CaptionSettings,
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
};

const DEFAULT_SETTINGS: CaptionSettings = {
  settingsVersion: 4,
  layout: 'stacked',
  primaryProfile: 'economy',
  shadowProfile: 'tiered',
  shadowEnabled: false,
  fastPath: true,
  provisionalTranslation: true,
  vadEnabled: false,
  vadThreshold: 0.012,
  delayProfile: 'low',
  budgetUsd: 5,
  glossary: [],
  captionFontScale: 1,
  captionPaceMs: 1200,
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

function targetText(target: TargetText, audience: 'en' | 'zh') {
  if (target.text) return target.text;
  if (target.status === 'failed') {
    return audience === 'en' ? 'Translation unavailable' : '翻译暂不可用';
  }
  return audience === 'en' ? 'Translating…' : '正在翻译…';
}

function captionPaceLabel(milliseconds: number) {
  if (milliseconds <= 700) return 'Fast';
  if (milliseconds >= 2100) return 'Relaxed';
  return 'Balanced';
}

export function ControlApp() {
  const [tab, setTab] = useState<Tab>('session');
  const [settings, setSettingsState] = useState(DEFAULT_SETTINGS);
  const [credential, setCredential] = useState<CredentialState | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [devices, setDevices] = useState<{ inputs: AudioDeviceOption[]; outputs: AudioDeviceOption[] }>({ inputs: [], outputs: [] });
  const [microphoneId, setMicrophoneId] = useState('');
  const [status, setStatus] = useState<SessionStatus>({ state: 'ready' });
  const [metrics, setMetrics] = useState<SessionMetrics>({});
  const [captions, setCaptions] = useState<CaptionEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [glossaryText, setGlossaryText] = useState('');
  const [sessionActive, setSessionActive] = useState(false);
  const [operation, setOperation] = useState<SessionOperation>('idle');
  const [previewing, setPreviewing] = useState(false);
  const [previewLevel, setPreviewLevel] = useState(0);
  const audio = useRef(new AudioCaptureController());
  const microphonePreview = useRef(new MicrophonePreviewController());
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
    ];
    void Promise.all([
      window.captions.getSettings(),
      window.captions.credentialStatus(),
      window.captions.getSessionStatus(),
      enumerateAudioDevices().catch(() => ({ inputs: [], outputs: [] })),
    ]).then(([settingsResult, credentialResult, sessionResult, deviceResult]) => {
      if (settingsResult.ok) {
        const next = settingsResult.data as unknown as CaptionSettings;
        setSettingsState(next);
        setGlossaryText(next.glossary.map((entry) => `${entry.en} = ${entry.zh}`).join('\n'));
      }
      if (credentialResult.ok) setCredential(credentialResult.data);
      if (sessionResult.ok && sessionResult.data.active) {
        setSessionActive(true);
        setStatus({ state: 'running' });
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
    if (!active) return;
    const timer = window.setInterval(() => {
      setMetrics((current) => ({ ...current, elapsedMs: (current.elapsedMs || 0) + 1000 }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const saveSettings = async (patch: Partial<CaptionSettings>) => {
    const optimistic = { ...settings, ...patch };
    setSettingsState(optimistic);
    const result = await window.captions.setSettings(patch as Record<string, unknown>);
    if (!result.ok) {
      setSettingsState(settings);
      setNotice(result.error.message);
    }
  };

  const start = async () => {
    const id = ++operationId.current;
    setSessionActive(true);
    setOperation('starting');
    setBusy(true);
    setNotice('');
    setCaptions([]);
    setMetrics({});
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
      setStatus({ state: 'ready' });
      setSessionActive(false);
      setOperation('idle');
      setBusy(false);
      return;
    }
    try {
      const capture = await audio.current.start(microphoneId || undefined);
      if (id !== operationId.current) {
        await audio.current.stop();
        return;
      }
      if (capture.warning) setNotice(capture.warning);
    } catch (error) {
      await window.captions.stopSession();
      if (id !== operationId.current) return;
      setNotice(error instanceof Error ? error.message : 'Audio capture could not start');
      setStatus({ state: 'ready' });
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
    const [, result] = await Promise.all([
      audio.current.stop(),
      window.captions.stopSession(),
    ]);
    if (!result.ok) setNotice(result.error.message);
    setStatus({ state: 'stopped' });
    setSessionActive(false);
    setOperation('idle');
    setBusy(false);
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
            ? 'Microphone access is disabled. Enable Bilingual Meeting Captions in System Settings → Privacy & Security → Microphone.'
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
      setKeyInput('');
      setNotice('API key validated and stored with macOS Keychain protection.');
    } else setNotice(result.error.message);
    setBusy(false);
  };

  const testSavedKey = async () => {
    setBusy(true);
    setNotice('');
    const result = await window.captions.validateCredential();
    setNotice(
      result.ok && result.data.valid
        ? 'OpenAI API connection succeeded. The saved key can access GPT Live Transcribe.'
        : result.ok
          ? result.data.error || 'OpenAI API connection failed.'
          : result.error.message,
    );
    setBusy(false);
  };

  const parseGlossary = () =>
    glossaryText
      .split('\n')
      .map((line) => line.split(/=|→/).map((value) => value.trim()))
      .filter(([en, zh]) => en && zh)
      .map(([en, zh]) => ({ en, zh }));

  const latest = useMemo(
    () =>
      [...captions].reverse().find((caption) => caption.status === 'final') ||
      captions[captions.length - 1],
    [captions],
  );
  const statusLabel =
    operation === 'starting'
      ? 'STARTING'
      : operation === 'stopping'
        ? 'ENDING'
        : active
          ? 'LIVE'
          : status.state === 'stopped'
            ? 'ENDED'
            : 'READY';

  return (
    <main className="control-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">BILINGUAL MEETING CAPTIONS</p>
          <h1>Live Caption Studio</h1>
        </div>
        <div className={`session-pill ${active ? 'is-live' : ''}`}>
          <i /> {statusLabel} <span>{formatElapsed(metrics.elapsedMs)}</span>
        </div>
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
              <div className="audio-row"><span>You / microphone</span><Level value={active ? metrics.levels?.microphone : previewLevel} /></div>
              <div className="audio-row"><span>Meeting / system</span><Level value={metrics.levels?.system} /></div>
              <p className="field-note">Use headphones to prevent the microphone from capturing meeting playback twice.</p>
            </article>

            <article className="card">
              <div className="section-heading">
                <div><p className="eyebrow">AUDIENCE VIEW</p><h2>Lower thirds</h2></div>
                <button className="text-button" onClick={() => void window.captions.showWindows()}>Show</button>
              </div>
              <div className="segmented">
                <button className={settings.layout === 'stacked' ? 'is-selected' : ''} onClick={() => void saveSettings({ layout: 'stacked' })}>Stacked</button>
                <button className={settings.layout === 'side-by-side' ? 'is-selected' : ''} onClick={() => void saveSettings({ layout: 'side-by-side' })}>Side by side</button>
              </div>
              <div className={`overlay-preview overlay-preview--${settings.layout}`}>
                <div className="preview-en"><span>ENGLISH</span>{latest ? targetText(latest.english, 'en') : 'English audience caption'}</div>
                <div className="preview-zh"><span>中文</span>{latest ? targetText(latest.chinese, 'zh') : '中文观众字幕'}</div>
              </div>
              <label className="field pace-control">
                <span className="pace-control__heading">
                  <span>Caption pace</span>
                  <output>
                    {captionPaceLabel(settings.captionPaceMs)} · {(settings.captionPaceMs / 1000).toFixed(1)}s
                  </output>
                </span>
                <input
                  type="range"
                  min="400"
                  max="3000"
                  step="100"
                  value={settings.captionPaceMs}
                  aria-label="Caption pace"
                  aria-valuetext={`${captionPaceLabel(settings.captionPaceMs)}, ${(settings.captionPaceMs / 1000).toFixed(1)} seconds between updates`}
                  onChange={(event) => void saveSettings({ captionPaceMs: Number(event.target.value) })}
                />
                <span className="pace-control__scale" aria-hidden="true">
                  <span>Fast</span>
                  <span>Relaxed</span>
                </span>
                <span className="pace-control__note">
                  Controls the subtitle display rhythm. Transcription and the session log remain live.
                </span>
              </label>
            </article>
          </div>

          <article className="card launch-card">
            <div>
              <p className="eyebrow">STATUS</p>
              <h2>{credential?.available ? 'Ready for a live meeting' : 'Add an API key for live mode'}</h2>
              <p>{credential?.available ? 'OpenAI connection is configured.' : 'Open Settings to add your private API key.'}</p>
            </div>
            <div className="launch-actions">
              {!active ? (
                <button className="button button--primary" disabled={busy || !credential?.available} onClick={() => void start()}>Start Session</button>
              ) : (
                <button className="button button--stop" disabled={operation === 'stopping'} onClick={() => void stop()}>
                  {operation === 'stopping' ? 'Stopping…' : 'Stop Session'}
                </button>
              )}
            </div>
          </article>

          {captions.length > 0 && (
            <article className="card transcript-card">
              <div className="section-heading"><div><p className="eyebrow">SESSION LOG</p><h2>Latest captions</h2></div><span>{captions.length} lines</span></div>
              <div className="transcript-list">
                {[...captions].reverse().slice(0, 5).map((caption) => (
                  <div key={caption.id}><span>{caption.sourceChannel === 'microphone' ? 'YOU' : 'MEETING'}</span><p>{targetText(caption.english, 'en')}</p><p lang="zh-Hans">{targetText(caption.chinese, 'zh')}</p></div>
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
            <label className="field"><span>{credential?.available ? 'Replace API key' : 'API key'}</span><input type="password" autoComplete="off" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} placeholder="sk-…" /></label>
            <div className="button-row">
              <button className="button button--primary" disabled={busy || !keyInput.trim()} onClick={() => void saveKey()}>Validate & save</button>
              {credential?.available && <button className="button button--secondary" disabled={busy} onClick={() => void testSavedKey()}>Test saved key</button>}
              {credential?.source === 'secure-storage' && <button className="button button--quiet" onClick={() => void window.captions.deleteCredential().then((result) => { if (result.ok) setCredential(result.data); })}>Remove saved key</button>}
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

          <article className="card">
            <p className="eyebrow">ENGINEERING TERMS</p><h2>Meeting glossary</h2>
            <p className="supporting-copy">One bilingual pair per line. These terms are supplied to both transcription and normalization.</p>
            <textarea rows={8} value={glossaryText} onChange={(event) => setGlossaryText(event.target.value)} placeholder={'boss = 凸台\nwall thickness = 壁厚\nDVT = DVT'} />
            <button className="button button--secondary" onClick={() => void saveSettings({ glossary: parseGlossary() })}>Save glossary</button>
          </article>

          <article className="card export-card">
            <p className="eyebrow">SESSION TRANSCRIPT</p><h2>Save this meeting</h2>
            <p className="supporting-copy">Save the bilingual captions, timing, and estimated cost. Audio is never included.</p>
            <div className="button-row"><button className="button button--secondary" onClick={() => void window.captions.exportSession('json')}>Save JSON</button><button className="button button--quiet" onClick={() => void window.captions.exportSession('markdown')}>Save readable transcript</button></div>
          </article>
        </section>
      )}

      <footer className="app-footer">
        <span>Estimated session cost <strong>${(metrics.totalUsd || 0).toFixed(3)}</strong> / ${(settings.budgetUsd || 0).toFixed(2)}</span>
        <span>Audio is streamed for transcription and is not written to disk.</span>
      </footer>
    </main>
  );
}
