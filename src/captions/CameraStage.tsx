import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { captionThemeById } from './captionThemes';
import { captionFontScale, clampHistoryEntries } from './captionScale';
// Shared with the on-screen overlay so both audience surfaces word a pending translation
// identically - two surfaces inventing their own placeholder is how they drift apart.
import { audienceCaptionText } from './CaptionSurface';
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

// Speaker attribution is deliberately NOT rendered here.
//
// The badge occupied a fixed column on every line - roughly 9% of the stage width
// - for a label a remote viewer cannot act on: they can already see who is
// speaking. Reclaiming that column gives the caption text materially more room,
// which matters most in side-by-side layout where horizontal space is scarcest.
// `sourceChannel` is still carried on each entry, because attribution remains
// meaningful for saved transcripts and for duplicate suppression.

/**
 * Operator chrome for the preview window.
 *
 * The stage is frameless so nothing decorates the picture, which also left no
 * visible way to move or dismiss it. This bar stays fully transparent until the
 * pointer is over the stage (or something in it takes keyboard focus), so an OBS
 * window capture of an unattended stage records nothing extra. It is rendered
 * only for `role=preview`; the offscreen window that actually feeds the camera
 * never mounts it.
 */
function StageChrome({ onHide }: { onHide: () => void }) {
  return (
    <div className="camera-stage__chrome">
      <span className="camera-stage__chrome-drag">Camera stage · preview</span>
      <button type="button" onClick={onHide}>
        Hide preview
      </button>
    </div>
  );
}

export function CameraStage() {
  const [entries, setEntries] = useState<CameraStageEntry[]>([]);
  const [status, setStatus] = useState<SessionStatus>({ state: 'ready' });
  const [historyEntries, setHistoryEntries] = useState(6);
  const [fontScale, setFontScale] = useState(1);
  // "Show early captions while speech is processing". The pipeline already honours it by
  // translating provisional transcripts, and the on-screen overlay already renders them; this
  // surface ignored it entirely and waited for settled text either way.
  const [showEarly, setShowEarly] = useState(true);
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
      // Previously ignored here, which is why the Caption size slider appeared to
      // do nothing whenever the virtual camera was the output.
      setFontScale(Number(settings.captionFontScale) || 1);
      setShowEarly(settings.provisionalTranslation !== false);
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

  /**
   * Settled entries, plus whatever is still in flight.
   *
   * This used to require `en.settled && zh.settled`, so the stage showed nothing at all until
   * a line was final in both languages - while the control window's session log showed the
   * provisional caption immediately. The operator saw every sentence appear in their own
   * window before it reached the audience, and the first sentence of a session looked like a
   * failure rather than a delay.
   *
   * Waiting is now the operator's choice rather than this file's. "Show early captions while
   * speech is processing" already exists, the pipeline already honours it by translating
   * provisional transcripts, and the on-screen overlay already renders them (see
   * `visibleCaptions`) - only this surface ignored it and waited regardless, so the two
   * audience views disagreed about what the audience should see.
   *
   * Turning the setting off restores the previous behaviour, which is a real preference for a
   * camera feed: text that rewrites itself in front of remote participants can be worse than a
   * short wait.
   *
   * In-flight entries are never dropped by the history cap: the cap limits how much settled
   * history is retained, and trimming the newest line - the one being spoken - is the opposite
   * of what it is for.
   */
  const visibleEntries = useMemo(() => {
    const mine = [...entries]
      .filter((entry) => entry.sessionId === activeSessionId.current)
      .sort((left, right) => left.sequence - right.sequence);
    const isSettled = (entry: CameraStageEntry) =>
      Boolean(entry.en?.settled && entry.zh?.settled);
    const settled = mine.filter(isSettled).slice(-historyEntries);
    if (!showEarly) return settled;
    return [...settled, ...mine.filter((entry) => !isSettled(entry))];
  }, [entries, historyEntries, showEarly]);
  const theme = captionThemeById(themeId);
  const live = status.state === 'running';
  // Opt-in, not opt-out: only an explicit `role=preview` gets operator chrome.
  // The offscreen window's pixels become the camera feed, and virtual-camera.md
  // forbids controls in it — so any surface that forgets to declare a role
  // renders the clean picture rather than accidentally leaking a button.
  const isPreview =
    new URLSearchParams(window.location.search).get('role') === 'preview';

  return (
    <main
      className={`camera-stage camera-stage--${layout}`}
      style={
        {
          '--stage-history-count': String(historyEntries),
          '--stage-density': String((historyEntries - 3) / 7),
          // Combines the operator's Caption size preference with the fit needed to
          // make the chosen history actually fill the fixed 16:9 frame.
          '--stage-scale': String(captionFontScale(fontScale, historyEntries)),
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
      {isPreview && (
        <StageChrome onHide={() => void window.captions.hideCameraStage?.()} />
      )}
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
                  visibleEntries.map((entry, index) => {
                    const caption = entry[audience];
                    const settled = Boolean(entry.en?.settled && entry.zh?.settled);
                    return (
                      <p
                        className={`camera-stage__entry${settled ? '' : ' is-provisional'}`}
                        data-age={visibleEntries.length - index - 1}
                        key={entry.id}
                      >
                        {/* The same fallback the overlay uses, so a line whose translation is
                            still running says so instead of rendering as an empty row that
                            silently takes up space on the audience's screen. */}
                        <strong>
                          {caption
                            ? audienceCaptionText(caption, audience)
                            : audience === 'en'
                              ? 'Translating…'
                              : '正在翻译…'}
                        </strong>
                      </p>
                    );
                  })
                )}
              </div>
            </section>
          ))}
        </>
      )}
    </main>
  );
}
