import React, { useEffect, useMemo, useState } from 'react';
import type { Audience, AudienceCaption, CaptionSettings, SessionStatus } from './types';

const MAX_VISIBLE_LINES = 3;

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

  useEffect(() => {
    const offCaption = window.captions.onAudienceCaption((event) => {
      setCaptions((current) => {
        if (event.suppressed) {
          return current.filter((item) => item.id !== event.id);
        }
        const next = [...current];
        const index = next.findIndex((item) => item.id === event.id);
        if (index >= 0) next[index] = event;
        else next.push(event);
        return next
          .sort((left, right) => left.sequence - right.sequence)
          .slice(-MAX_VISIBLE_LINES);
      });
    });
    const offStatus = window.captions.onStatus(setStatus);
    const offSettings = window.captions.onSettings((value) => {
      const settings = value as unknown as CaptionSettings;
      setFontScale(settings.captionFontScale || 1);
    });
    void window.captions.getSettings().then((result) => {
      if (result.ok) {
        const settings = result.data as unknown as CaptionSettings;
        setFontScale(settings.captionFontScale || 1);
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

  const visible = useMemo(() => captions.slice(-MAX_VISIBLE_LINES), [captions]);
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
      style={{ '--caption-scale': fontScale } as React.CSSProperties}
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
        {visible.length === 0 ? (
          <p className="caption-roll__empty">{emptyText}</p>
        ) : (
          visible.map((caption, index) => {
            const text = audienceCaptionText(caption, audience);
            return (
              <p
                className={`caption-line ${caption.status === 'final' ? 'is-final' : 'is-provisional'}`}
                data-age={visible.length - index - 1}
                key={caption.id}
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
      </section>
    </main>
  );
}
