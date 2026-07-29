import React, { useEffect, useMemo, useState } from 'react';
import type { Audience, AudienceCaption, CaptionSettings, SessionStatus } from './types';

const MAX_VISIBLE_LINES = 3;

export function CaptionSurface({ audience }: { audience: Audience }) {
  const [captions, setCaptions] = useState<AudienceCaption[]>([]);
  const [status, setStatus] = useState<SessionStatus>({ state: 'ready' });
  const [fontScale, setFontScale] = useState(1);

  useEffect(() => {
    const offCaption = window.captions.onAudienceCaption((event) => {
      setCaptions((current) => {
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
    return () => {
      offCaption();
      offStatus();
      offSettings();
    };
  }, []);

  const visible = useMemo(() => captions.slice(-MAX_VISIBLE_LINES), [captions]);
  const label = audience === 'en' ? 'ENGLISH' : '中文';
  const emptyText =
    status.state === 'running'
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
        <span>{label}</span>
        <span className="caption-surface__status">
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
      </header>
      <section className="caption-roll">
        {visible.length === 0 ? (
          <p className="caption-roll__empty">{emptyText}</p>
        ) : (
          visible.map((caption, index) => {
            const text =
              caption.text ||
              (audience === 'en' ? 'Translation unavailable' : '翻译暂不可用');
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
