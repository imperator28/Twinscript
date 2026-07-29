import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioCaptureController, enumerateAudioDevices, type AudioDeviceOption } from './audioCapture';
import { EvaluationPanel } from './EvaluationPanel';
import {
  SCREENING_CORPUS,
  SCREENING_CORPUS_SUMMARY,
} from './screeningCorpus';
import type {
  CaptionEvent,
  CaptionSettings,
  EvaluationResult,
  SessionMetrics,
  SessionStatus,
} from './types';

type Tab = 'session' | 'compare' | 'settings';
type CredentialState = {
  available: boolean;
  source: string;
  encryptionAvailable: boolean;
};
type Recording = {
  id: string;
  startedAt: number;
  endedAt?: number;
  counts: Record<string, number>;
};

const DEFAULT_SETTINGS: CaptionSettings = {
  layout: 'stacked',
  primaryProfile: 'economy',
  shadowProfile: 'tiered',
  shadowEnabled: true,
  fastPath: true,
  provisionalTranslation: true,
  vadEnabled: true,
  vadThreshold: 0.012,
  delayProfile: 'low',
  budgetUsd: 5,
  glossary: [],
  captionFontScale: 1,
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
  const [evaluations, setEvaluations] = useState<EvaluationResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [glossaryText, setGlossaryText] = useState('');
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recordingId, setRecordingId] = useState('');
  const [screeningEnabled, setScreeningEnabled] = useState(false);
  const [screeningIndex, setScreeningIndex] = useState(0);
  const audio = useRef(new AudioCaptureController());
  const active = ['starting', 'running', 'degraded', 'budget-warning'].includes(status.state);

  useEffect(() => {
    const cleanups = [
      window.captions.onStatus(setStatus),
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
      window.captions.onEvaluation((value) => setEvaluations((current) => [...current, value].slice(-100))),
    ];
    void Promise.all([
      window.captions.getSettings(),
      window.captions.credentialStatus(),
      window.captions.getSessionStatus(),
      window.captions.listRecordings(),
      enumerateAudioDevices().catch(() => ({ inputs: [], outputs: [] })),
    ]).then(([settingsResult, credentialResult, sessionResult, recordingResult, deviceResult]) => {
      if (settingsResult.ok) {
        const next = settingsResult.data as unknown as CaptionSettings;
        setSettingsState(next);
        setGlossaryText(next.glossary.map((entry) => `${entry.en} = ${entry.zh}`).join('\n'));
      }
      if (credentialResult.ok) setCredential(credentialResult.data);
      if (sessionResult.ok && sessionResult.data.active) setStatus({ state: 'running' });
      if (recordingResult.ok) {
        setRecordings(recordingResult.data);
        setRecordingId(recordingResult.data[0]?.id || '');
      }
      setDevices(deviceResult);
      setMicrophoneId(deviceResult.inputs[0]?.deviceId || '');
    });
    return () => cleanups.forEach((cleanup) => cleanup());
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

  const start = async (mode: 'live' | 'mock') => {
    setBusy(true);
    setNotice('');
    setCaptions([]);
    setEvaluations([]);
    setMetrics({});
    const result = await window.captions.startSession({
      mode,
      settings,
      screeningPrompt:
        mode === 'live' && screeningEnabled
          ? SCREENING_CORPUS[screeningIndex]
          : null,
    });
    if (!result.ok) {
      setNotice(result.error.message);
      setStatus({ state: 'ready' });
      setBusy(false);
      return;
    }
    if (mode === 'live') {
      try {
        await audio.current.start(microphoneId || undefined);
      } catch (error) {
        await window.captions.stopSession();
        setNotice(error instanceof Error ? error.message : 'Audio capture could not start');
        setStatus({ state: 'ready' });
        setBusy(false);
        return;
      }
    }
    setStatus({ state: 'running', mode });
    setBusy(false);
  };

  const replay = async () => {
    if (!recordingId) return;
    setBusy(true);
    setCaptions([]);
    setEvaluations([]);
    const result = await window.captions.startSession({
      mode: 'replay',
      recordingId,
      settings: { ...settings, recordEvaluation: false },
    });
    if (!result.ok) setNotice(result.error.message);
    else setStatus({ state: 'running', mode: 'replay' });
    setBusy(false);
  };

  const stop = async () => {
    setBusy(true);
    await audio.current.stop();
    const result = await window.captions.stopSession();
    if (!result.ok) setNotice(result.error.message);
    setStatus({ state: 'stopped' });
    setBusy(false);
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
  const screeningPrompt = SCREENING_CORPUS[screeningIndex];
  const selectScreeningPrompt = async (index: number) => {
    const bounded = Math.max(0, Math.min(SCREENING_CORPUS.length - 1, index));
    setScreeningIndex(bounded);
    if (active && screeningEnabled) {
      const result = await window.captions.setScreeningPrompt(
        SCREENING_CORPUS[bounded],
      );
      if (!result.ok) setNotice(result.error.message);
    }
  };
  const statusLabel = active ? 'LIVE' : status.state === 'stopped' ? 'ENDED' : 'READY';

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
        {(['session', 'compare', 'settings'] as Tab[]).map((item) => (
          <button className={tab === item ? 'is-selected' : ''} key={item} onClick={() => setTab(item)}>
            {item === 'session' ? 'Session' : item === 'compare' ? `Compare${evaluations.length ? ` · ${evaluations.length}` : ''}` : 'Settings'}
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
                <button className="text-button" onClick={() => void enumerateAudioDevices(true).then((next) => { setDevices(next); setMicrophoneId((current) => current || next.inputs[0]?.deviceId || ''); })}>Grant / refresh</button>
              </div>
              <label className="field">
                <span>Microphone</span>
                <select disabled={active} value={microphoneId} onChange={(event) => setMicrophoneId(event.target.value)}>
                  {devices.inputs.length === 0 && <option value="">Permission required</option>}
                  {devices.inputs.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}
                </select>
              </label>
              <div className="audio-row"><span>You / microphone</span><Level value={metrics.levels?.microphone} /></div>
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
              <div className="overlay-preview">
                <div className="preview-en"><span>ENGLISH</span>{latest?.english.text || 'English audience caption'}</div>
                <div className="preview-zh"><span>中文</span>{latest?.chinese.text || '中文观众字幕'}</div>
              </div>
            </article>
          </div>

          <article className="card launch-card">
            <div>
              <p className="eyebrow">READY CHECK</p>
              <h2>{credential?.available ? 'Ready for a live meeting' : 'Add an API key for live mode'}</h2>
              <p>{credential?.available ? `Credential: ${credential.source.replace('-', ' ')}` : 'Demo mode is available without a key or microphone.'}</p>
            </div>
            <div className="launch-actions">
              {!active ? (
                <>
                  <button className="button button--secondary" disabled={busy} onClick={() => void start('mock')}>Demo Session</button>
                  {recordings.length > 0 && (
                    <button className="button button--quiet" disabled={busy} onClick={() => void replay()}>Replay Last</button>
                  )}
                  <button className="button button--primary" disabled={busy || !credential?.available} onClick={() => void start('live')}>Start Live Session</button>
                </>
              ) : (
                <button className="button button--stop" disabled={busy} onClick={() => void stop()}>End Session</button>
              )}
            </div>
          </article>

          <article className="card screening-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">PHASE 1 SCREENING</p>
                <h2>Scripted bilingual prompt runner</h2>
              </div>
              <label className="toggle toggle--compact">
                <input
                  type="checkbox"
                  disabled={active}
                  checked={screeningEnabled}
                  onChange={(event) => setScreeningEnabled(event.target.checked)}
                />
                <span>Use corpus</span>
              </label>
            </div>
            <p className="supporting-copy">
              {SCREENING_CORPUS_SUMMARY.total} consent-safe prompts ·{' '}
              {SCREENING_CORPUS_SUMMARY.codeSwitch} code-switch ·{' '}
              {SCREENING_CORPUS_SUMMARY.critical} with critical values. Results
              are evidence only when captured from real speech.
            </p>
            {screeningEnabled && (
              <div className="screening-runner">
                <div className="screening-meta">
                  <span>
                    {screeningIndex + 1} / {SCREENING_CORPUS.length}
                  </span>
                  <span>{screeningPrompt.languageClass.replace('-', ' ')}</span>
                  <span>
                    {screeningPrompt.sourceChannel === 'microphone'
                      ? 'Speak into microphone'
                      : 'Play through meeting/system audio'}
                  </span>
                </div>
                <p className="screening-condition">{screeningPrompt.condition}</p>
                <blockquote lang={screeningPrompt.languageClass === 'en' ? 'en' : 'zh-Hans'}>
                  {screeningPrompt.sourceText}
                </blockquote>
                <details className="diagnostic-details">
                  <summary>Reference meaning and protected values</summary>
                  <p lang="en">{screeningPrompt.englishReference}</p>
                  <p lang="zh-Hans">{screeningPrompt.chineseReference}</p>
                  <p>
                    Protected:{' '}
                    {screeningPrompt.protectedTokens.join(' · ') || 'None'}
                  </p>
                </details>
                <div className="screening-actions">
                  <button
                    className="button button--quiet"
                    disabled={screeningIndex === 0}
                    onClick={() => void selectScreeningPrompt(screeningIndex - 1)}
                  >
                    Previous
                  </button>
                  <button
                    className="button button--secondary"
                    disabled={screeningIndex === SCREENING_CORPUS.length - 1}
                    onClick={() => void selectScreeningPrompt(screeningIndex + 1)}
                  >
                    Mark spoken · Next
                  </button>
                </div>
              </div>
            )}
          </article>

          {captions.length > 0 && (
            <article className="card transcript-card">
              <div className="section-heading"><div><p className="eyebrow">SESSION LOG</p><h2>Latest captions</h2></div><span>{captions.length} lines</span></div>
              <div className="transcript-list">
                {[...captions].reverse().slice(0, 5).map((caption) => (
                  <div key={caption.id}><span>{caption.sourceChannel === 'microphone' ? 'YOU' : 'MEETING'}</span><p>{caption.english.text || caption.sourceText}</p><p lang="zh-Hans">{caption.chinese.text || caption.sourceText}</p></div>
                ))}
              </div>
            </article>
          )}
        </section>
      )}

      {tab === 'compare' && <EvaluationPanel results={evaluations} />}

      {tab === 'settings' && (
        <section className="settings-layout">
          <article className="card">
            <p className="eyebrow">OPENAI</p><h2>Private API credential</h2>
            <p className="supporting-copy">The renderer never reads a saved key. In the packaged app it is encrypted using macOS Keychain; local development may use the git-ignored <code>.env.local</code>.</p>
            <label className="field"><span>{credential?.available ? 'Replace API key' : 'API key'}</span><input type="password" autoComplete="off" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} placeholder="sk-…" /></label>
            <div className="button-row"><button className="button button--primary" disabled={busy || !keyInput.trim()} onClick={() => void saveKey()}>Validate & save</button>{credential?.source === 'secure-storage' && <button className="button button--quiet" onClick={() => void window.captions.deleteCredential().then((result) => { if (result.ok) setCredential(result.data); })}>Remove saved key</button>}</div>
          </article>

          <article className="card">
            <p className="eyebrow">A/B FOUNDATION</p><h2>Model profiles</h2>
            <label className="field"><span>Primary audience profile</span><select disabled={active} value={settings.primaryProfile} onChange={(event) => void saveSettings({ primaryProfile: event.target.value as CaptionSettings['primaryProfile'] })}><option value="economy">Economy · nano/nano</option><option value="tiered">Tiered · nano/luna final</option><option value="quality">Quality · luna/luna</option></select></label>
            <label className="toggle"><input type="checkbox" disabled={active} checked={settings.shadowEnabled} onChange={(event) => void saveSettings({ shadowEnabled: event.target.checked })} /><span>Run a shadow comparison</span></label>
            <label className="field"><span>Shadow profile</span><select disabled={active || !settings.shadowEnabled} value={settings.shadowProfile} onChange={(event) => void saveSettings({ shadowProfile: event.target.value as CaptionSettings['shadowProfile'] })}><option value="economy">Economy</option><option value="tiered">Tiered</option><option value="quality">Quality</option></select></label>
            <label className="field"><span>Session budget cap (USD)</span><input type="number" min="0.5" max="50" step="0.5" value={settings.budgetUsd} onChange={(event) => void saveSettings({ budgetUsd: Number(event.target.value) })} /></label>
            {active && settings.shadowEnabled && (
              <button
                className="button button--quiet"
                onClick={() => void window.captions.abortShadow().then((result) => {
                  setNotice(result.ok ? 'Shadow comparison stopped. Primary audience captions continue.' : result.error.message);
                })}
              >
                Stop shadow comparison
              </button>
            )}
          </article>

          <article className="card">
            <p className="eyebrow">CAPTION BEHAVIOR</p><h2>Stability and timing</h2>
            <label className="toggle"><input type="checkbox" checked={settings.provisionalTranslation} onChange={(event) => void saveSettings({ provisionalTranslation: event.target.checked })} /><span>Show provisional translation</span></label>
            <label className="toggle"><input type="checkbox" checked={settings.vadEnabled} onChange={(event) => void saveSettings({ vadEnabled: event.target.checked })} /><span>Local voice activity gate</span></label>
            <label className="field"><span>Transcription delay</span><select value={settings.delayProfile} onChange={(event) => void saveSettings({ delayProfile: event.target.value as CaptionSettings['delayProfile'] })}><option value="minimal">Minimal</option><option value="low">Low</option><option value="default">Default</option></select></label>
            <label className="field"><span>Caption size · {Math.round(settings.captionFontScale * 100)}%</span><input type="range" min="0.8" max="1.4" step="0.05" value={settings.captionFontScale} onChange={(event) => void saveSettings({ captionFontScale: Number(event.target.value) })} /></label>
          </article>

          <article className="card">
            <p className="eyebrow">ENGINEERING TERMS</p><h2>Meeting glossary</h2>
            <p className="supporting-copy">One bilingual pair per line. These terms are supplied to both transcription and normalization.</p>
            <textarea rows={8} value={glossaryText} onChange={(event) => setGlossaryText(event.target.value)} placeholder={'boss = 凸台\nwall thickness = 壁厚\nDVT = DVT'} />
            <button className="button button--secondary" onClick={() => void saveSettings({ glossary: parseGlossary() })}>Save glossary</button>
          </article>

          <article className="card export-card">
            <p className="eyebrow">VALIDATION LOG</p><h2>Export this session</h2>
            <p className="supporting-copy">Exports include settings, routing, model profile, latency, token use, and estimated cost. Raw audio is stored only when encrypted evaluation recording is explicitly enabled.</p>
            <label className="toggle"><input type="checkbox" disabled={active} checked={settings.recordEvaluation} onChange={(event) => void saveSettings({ recordEvaluation: event.target.checked })} /><span>Record an encrypted evaluation fixture</span></label>
            {settings.recordEvaluation && <p className="recording-warning">Recording stores encrypted microphone and meeting audio on this Mac. Use only with participant consent.</p>}
            {recordings.length > 0 && (
              <label className="field"><span>Encrypted replay fixture</span><select value={recordingId} onChange={(event) => setRecordingId(event.target.value)}>{recordings.map((recording) => <option value={recording.id} key={recording.id}>{new Date(recording.startedAt).toLocaleString()} · {recording.counts.caption || 0} captions</option>)}</select></label>
            )}
            <div className="button-row"><button className="button button--secondary" onClick={() => void window.captions.exportSession('json')}>Export JSON</button><button className="button button--quiet" onClick={() => void window.captions.exportSession('markdown')}>Export readable log</button></div>
          </article>
        </section>
      )}

      <footer className="app-footer">
        <span>Estimated session cost <strong>${(metrics.totalUsd || 0).toFixed(3)}</strong> / ${(settings.budgetUsd || 0).toFixed(2)}</span>
        <span>{settings.recordEvaluation ? 'Encrypted evaluation recording is enabled.' : 'Audio is streamed for transcription and is not written to disk.'}</span>
      </footer>
    </main>
  );
}
