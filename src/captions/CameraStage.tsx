import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { captionThemeById } from './captionThemes';
import type {
  AudienceCaption,
  CaptionSettings,
  SessionStatus,
} from './types';

interface CameraStageEntry {
  id: string;
  sessionId: string;
  sequence: number;
  sourceChannel: 'microphone' | 'system';
  en?: AudienceCaption;
  zh?: AudienceCaption;
}

const clampHistoryEntries = (value: number) =>
  Math.max(3, Math.min(10, Math.round(Number(value) || 6)));

function entrySpeaker(
  sourceChannel: CameraStageEntry['sourceChannel'],
  audience: 'en' | 'zh',
) {
  if (sourceChannel === 'microphone') return audience === 'en' ? 'YOU' : '你';
  return audience === 'en' ? 'MEETING' : '会议';
}

export function CameraStage() {
  const [entries, setEntries] = useState<CameraStageEntry[]>([]);
  const [status, setStatus] = useState<SessionStatus>({ state: 'ready' });
  const [historyEntries, setHistoryEntries] = useState(6);
  const [layout, setLayout] = useState<CaptionSettings['layout']>('stacked');
  const [themeId, setThemeId] = useState<CaptionSettings['captionTheme']>(
    'blueprint',
  );
  const activeSessionId = useRef<string | null>(null);

  useEffect(() => {
    const applyCaption = (caption: AudienceCaption) => {
      if (
        activeSessionId.current &&
        caption.sessionId !== activeSessionId.current
      ) {
        return;
      }
      setEntries((current) => {
        if (caption.suppressed) {
          return current.filter((entry) => entry.id !== caption.id);
        }
        const next = [...current];
        const index = next.findIndex((entry) => entry.id === caption.id);
        const existing =
          index >= 0
            ? next[index]
            : {
                id: caption.id,
                sessionId: caption.sessionId,
                sequence: caption.sequence,
                sourceChannel: caption.sourceChannel,
              };
        const currentAudience = existing[caption.audience];
        if (
          currentAudience &&
          currentAudience.revision > caption.revision
        ) {
          return current;
        }
        const updated = { ...existing, [caption.audience]: caption };
        if (index >= 0) next[index] = updated;
        else next.push(updated);
        return next;
      });
    };
    const applyStatus = (nextStatus: SessionStatus) => {
      if (nextStatus.state === 'starting' && nextStatus.sessionId) {
        if (activeSessionId.current !== nextStatus.sessionId) {
          activeSessionId.current = nextStatus.sessionId;
          setEntries([]);
        }
      } else if (
        nextStatus.state === 'running' &&
        nextStatus.sessionId &&
        !activeSessionId.current
      ) {
        activeSessionId.current = nextStatus.sessionId;
      } else if (
        ['stopped', 'ready', 'budget-exhausted'].includes(nextStatus.state)
      ) {
        activeSessionId.current = null;
        setEntries([]);
      }
      setStatus(nextStatus);
    };
    const offCaption = window.captions.onAudienceCaption(applyCaption);
    const offStatus = window.captions.onStatus(applyStatus);
    const hideOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void window.captions.hideCameraStage();
    };
    window.addEventListener('keydown', hideOnEscape);
    const applySettings = (value: Record<string, unknown>) => {
      const settings = value as unknown as CaptionSettings;
      setHistoryEntries(clampHistoryEntries(settings.captionHistoryEntries));
      setLayout(settings.layout === 'side-by-side' ? 'side-by-side' : 'stacked');
      setThemeId(settings.captionTheme || 'blueprint');
    };
    const offSettings = window.captions.onSettings(applySettings);
    void window.captions.getSettings().then((result) => {
      if (result.ok) applySettings(result.data);
    });
    void window.captions.getCameraStageSnapshot().then((result) => {
      if (!result.ok) return;
      applyStatus(result.data.status);
      for (const caption of result.data.captions) applyCaption(caption);
    });
    return () => {
      offCaption();
      offStatus();
      offSettings();
      window.removeEventListener('keydown', hideOnEscape);
    };
  }, []);

  const visibleEntries = useMemo(
    () =>
      [...entries]
        .filter(
          (entry) =>
            entry.en?.settled &&
            entry.zh?.settled &&
            entry.sessionId === activeSessionId.current,
        )
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-historyEntries),
    [entries, historyEntries],
  );
  const theme = captionThemeById(themeId);
  const live = status.state === 'running';

  return (
    <main
      className={`camera-stage camera-stage--${layout}`}
      style={
        {
          '--stage-history-count': String(historyEntries),
          '--stage-density': String((historyEntries - 3) / 7),
          '--stage-en-background': theme.surfaces.en.background,
          '--stage-en-primary': theme.surfaces.en.primary,
          '--stage-en-secondary': theme.surfaces.en.secondary,
          '--stage-zh-background': theme.surfaces.zh.background,
          '--stage-zh-primary': theme.surfaces.zh.primary,
          '--stage-zh-secondary': theme.surfaces.zh.secondary,
        } as CSSProperties
      }
      aria-live="polite"
      aria-atomic="false"
    >
      {!live ? (
        <section className="camera-stage__slate">
          <div className="camera-stage__mark" aria-hidden="true">EN / 中</div>
          <h1>Bilingual captions ready</h1>
          <p>The live bilingual feed appears when the meeting starts.</p>
        </section>
      ) : (
        <>
          {(['en', 'zh'] as const).map((audience) => (
            <section
              className={`camera-stage__audience camera-stage__audience--${audience}`}
              key={audience}
              lang={audience === 'zh' ? 'zh-Hans' : 'en'}
            >
              <header>
                <span>{audience === 'en' ? 'ENGLISH' : '中文'}</span>
                <span className="camera-stage__live">
                  <i aria-hidden="true" />
                  {audience === 'en' ? 'LIVE' : '实时'}
                </span>
              </header>
              <div className="camera-stage__history">
                {visibleEntries.length === 0 ? (
                  <p className="camera-stage__listening">
                    {audience === 'en' ? 'Listening…' : '正在聆听…'}
                  </p>
                ) : (
                  visibleEntries.map((entry, index) => (
                    <p
                      className="camera-stage__entry"
                      data-age={visibleEntries.length - index - 1}
                      key={entry.id}
                    >
                      <span>{entrySpeaker(entry.sourceChannel, audience)}</span>
                      <strong>{entry[audience]?.text}</strong>
                    </p>
                  ))
                )}
              </div>
            </section>
          ))}
        </>
      )}
    </main>
  );
}
