import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Audience, AudienceCaption, CaptionSettings, SessionStatus } from './types';
import { captionThemeById } from './captionThemes';

const clampHistoryEntries = (value: number) =>
  Math.max(3, Math.min(10, Math.round(Number(value) || 6)));

const MAX_RETAINED_SETTLED = 10;

export function retainCaptionBuffer(captions: AudienceCaption[]) {
  const ordered = [...captions].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const completed = ordered
    .filter((caption) => caption.settled)
    .slice(-MAX_RETAINED_SETTLED);
  const inFlight = ordered.filter((caption) => !caption.settled);
  return [...completed, ...inFlight].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function visibleCaptions(
  captions: AudienceCaption[],
  completedLimit: number,
) {
  const ordered = [...captions].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const completed = ordered
    .filter((caption) => caption.settled)
    .slice(-completedLimit);
  const inFlight = ordered.filter((caption) => !caption.settled);
  return [...completed, ...inFlight].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function audienceCaptionText(
  caption: AudienceCaption,
  audience: Audience,
) {
  if (caption.text) return caption.text;
  if (caption.status === 'failed') {
    return audience === 'en' ? 'Translation unavailable' : '翻译暂不可用';
  }
  return audience === 'en' ? 'Translating…' : '正在翻译…';
}

export function CaptionSurface({ audience }: { audience: Audience }) {
  const [captions, setCaptions] = useState<AudienceCaption[]>([]);
  const [status, setStatus] = useState<SessionStatus>({ state: 'ready' });
  const [fontScale, setFontScale] = useState(1);
  const [historyEntries, setHistoryEntries] = useState(6);
  const [themeId, setThemeId] = useState<CaptionSettings['captionTheme']>(
    'blueprint',
  );
  const [autoSizeGeneration, setAutoSizeGeneration] = useState(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const offCaption = window.captions.onAudienceCaption((event) => {
      setCaptions((current) => {
        if (
          activeSessionIdRef.current &&
          event.sessionId !== activeSessionIdRef.current
        ) {
          return current;
        }
        if (event.suppressed) {
          return current.filter((item) => item.id !== event.id);
        }
        const next = [...current];
        const index = next.findIndex((item) => item.id === event.id);
        if (index >= 0) next[index] = event;
        else next.push(event);
        return retainCaptionBuffer(next);
      });
    });
    const offStatus = window.captions.onStatus((nextStatus) => {
      if (nextStatus.state === 'starting' && nextStatus.sessionId) {
        if (activeSessionIdRef.current !== nextStatus.sessionId) {
          activeSessionIdRef.current = nextStatus.sessionId;
          setCaptions([]);
        }
      }
      setStatus(nextStatus);
    });
    const offSettings = window.captions.onSettings((value) => {
      const settings = value as unknown as CaptionSettings;
      setFontScale(settings.captionFontScale || 1);
      setThemeId(settings.captionTheme || 'blueprint');
      setAutoSizeGeneration(settings.captionAutoSizeGeneration || 0);
      const nextHistory = clampHistoryEntries(settings.captionHistoryEntries);
      setHistoryEntries(nextHistory);
    });
    void window.captions.getSettings().then((result) => {
      if (result.ok) {
        const settings = result.data as unknown as CaptionSettings;
        setFontScale(settings.captionFontScale || 1);
        setThemeId(settings.captionTheme || 'blueprint');
        setAutoSizeGeneration(settings.captionAutoSizeGeneration || 0);
        const nextHistory = clampHistoryEntries(settings.captionHistoryEntries);
        setHistoryEntries(nextHistory);
      }
    });
    const hideOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void window.captions.hideWindows();
    };
    window.addEventListener('keydown', hideOnEscape);
    return () => {
      offCaption();
      offStatus();
      offSettings();
      window.removeEventListener('keydown', hideOnEscape);
    };
  }, []);

  useEffect(() => {
    const element = contentRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.height;
      if (!Number.isFinite(measured)) return;
      void window.captions.reportCaptionContentHeight(
        audience,
        Math.ceil(measured + 51),
        autoSizeGeneration,
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [audience, autoSizeGeneration]);

  const visible = useMemo(
    () => visibleCaptions(captions, historyEntries),
    [captions, historyEntries],
  );
  const focusedIds = useMemo(() => {
    const settled = visible.filter((caption) => caption.settled).slice(-2);
    return new Set([
      ...visible.filter((caption) => !caption.settled).map((caption) => caption.id),
      ...settled.map((caption) => caption.id),
    ]);
  }, [visible]);
  const themeSurface = captionThemeById(themeId).surfaces[audience];
  const label = audience === 'en' ? 'ENGLISH' : '中文';
  const emptyText =
    status.state === 'starting'
      ? audience === 'en'
        ? 'Connecting…'
        : '正在连接…'
      : status.state === 'degraded'
        ? audience === 'en'
          ? 'Connection issue — check the control window'
          : '连接异常，请查看控制窗口'
        : status.state === 'running'
      ? audience === 'en'
        ? 'Listening…'
        : '正在聆听…'
      : audience === 'en'
        ? 'English captions ready'
        : '中文字幕已就绪';

  return (
    <main
      className={`caption-surface caption-surface--${audience}`}
      style={
        {
          '--caption-scale': fontScale,
          '--caption-background': themeSurface.background,
          '--caption-primary': themeSurface.primary,
          '--caption-secondary': themeSurface.secondary,
          '--caption-accent': themeSurface.accent,
          '--caption-border': themeSurface.border,
        } as React.CSSProperties
      }
      aria-live="polite"
      aria-atomic="false"
    >
      <header className="caption-surface__header">
        <span className="caption-surface__drag-handle" aria-hidden="true" />
        <span>{label}</span>
        <span className="caption-surface__actions">
          <span className="caption-surface__status" title={status.message}>
            <i className={status.state === 'running' ? 'is-live' : ''} />
            {status.state === 'running'
              ? audience === 'en'
                ? 'LIVE'
                : '实时'
              : status.state === 'degraded'
                ? audience === 'en'
                  ? 'CHECK CONNECTION'
                  : '请检查连接'
                : ''}
          </span>
          <button
            className="caption-surface__close"
            type="button"
            aria-label={audience === 'en' ? 'Hide caption windows' : '隐藏字幕窗口'}
            title={audience === 'en' ? 'Hide both caption windows' : '隐藏两个字幕窗口'}
            onClick={() => void window.captions.hideWindows()}
          >
            ×
          </button>
        </span>
      </header>
      <section className="caption-roll">
        <div className="caption-content" ref={contentRef}>
        {visible.length === 0 ? (
          <p className="caption-roll__empty">{emptyText}</p>
        ) : (
          visible.map((caption, index) => {
            const text = audienceCaptionText(caption, audience);
            const focused = focusedIds.has(caption.id);
            return (
              <p
                className={`caption-line ${focused ? 'is-focused' : 'is-history'} ${caption.status === 'final' ? 'is-final' : 'is-provisional'}`}
                data-age={visible.length - index - 1}
                key={caption.id}
                style={{
                  opacity: focused
                    ? 1
                    : Math.max(
                        0.42,
                        1 - (visible.length - index - 1) * 0.12,
                      ),
                }}
              >
                <span className="caption-line__speaker">
                  {caption.sourceChannel === 'microphone'
                    ? audience === 'en'
                      ? 'YOU'
                      : '你'
                    : audience === 'en'
                      ? 'MEETING'
                      : '会议'}
                </span>
                <span>{text}</span>
              </p>
            );
          })
        )}
        </div>
      </section>
    </main>
  );
}
