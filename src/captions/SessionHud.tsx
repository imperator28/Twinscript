import { useEffect, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import type { SessionMetrics, SessionStatus } from './types';

/**
 * The floating session HUD.
 *
 * A running session could become impossible to stop. The caption overlays and
 * the camera stage are always-on-top, so they can cover the control window
 * completely, and Stop lived only inside it - the only way out was to close the
 * caption windows first, then hunt for the button. This pill floats above
 * everything with the session's state and its own Stop.
 *
 * Collapsed it is status only: a live dot and the elapsed time, small enough to
 * park at a screen edge and forget. The pointer arriving is what reveals Stop -
 * so the destructive control cannot be hit by accident, but is one deliberate
 * movement away.
 *
 * The window is resized by the main process to match whichever state this is in
 * (see session-hud-dock.js). It is not one big transparent window: a transparent
 * frameless window still swallows clicks over its see-through area, which would
 * block whatever sits underneath.
 */

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function SessionHud() {
  const [status, setStatus] = useState<SessionStatus>({ state: 'ready' });
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dockEdge, setDockEdge] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  // The main process owns the window size, so the renderer must not ask for the
  // same state twice - each request is a real window resize.
  const lastRequested = useRef<boolean | null>(null);
  const collapseTimer = useRef<number | null>(null);

  /**
   * Expand immediately, collapse only after a pause.
   *
   * Reported as being unable to stop a session from the pill, and this is why.
   * Expanding resizes the window, which moves its edges out from under the
   * cursor; Chromium then fires `pointerleave`, which collapsed it, which resized
   * it back, which fired `pointerenter` again. Stop appeared and vanished faster
   * than it could be clicked.
   *
   * The delay breaks that loop: a leave caused by the window moving is cancelled
   * by the enter that immediately follows it, while a real departure still
   * collapses a moment later.
   */
  const requestExpanded = (next: boolean) => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    if (next) {
      setExpanded(true);
      return;
    }
    collapseTimer.current = window.setTimeout(() => {
      collapseTimer.current = null;
      setExpanded(false);
    }, 420);
  };

  useEffect(
    () => () => {
      if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    },
    [],
  );

  // The stylesheet paints `--surface-sunken` on :root for the control window.
  // This window is transparent, so inheriting that would draw an opaque grey
  // rectangle around the pill and lose the floating effect entirely - the shape
  // would be a card, not a pill on the desktop.
  useEffect(() => {
    const root = document.documentElement;
    const { body } = document;
    const previous = { root: root.style.background, body: body.style.background };
    root.style.background = 'transparent';
    body.style.background = 'transparent';
    return () => {
      root.style.background = previous.root;
      body.style.background = previous.body;
    };
  }, []);

  // Every subscription is attempted independently and none of them may take the
  // pill down.
  //
  // The preload keeps its own allowlist of event channels and `subscribe()`
  // THROWS for anything missing from it. Optional chaining is no defence: the
  // method exists and is callable, it just throws. One absent string in that Set
  // put this whole surface into the error boundary, whose message overflows a
  // 36px window - so the reported symptom was a blank pill with a scrollbar,
  // nothing that pointed at a channel name.
  //
  // `preload-channels.test.cjs` now fails if a channel is missing. This is the
  // second layer: even then the HUD keeps its Stop button, which is the entire
  // reason it exists.
  useEffect(() => {
    const attach = <T,>(
      subscribe: ((callback: (payload: T) => void) => () => void) | undefined,
      handler: (payload: T) => void,
    ): (() => void) => {
      if (typeof subscribe !== 'function') return () => {};
      try {
        return subscribe(handler);
      } catch (error) {
        console.warn('[Twinscript] session HUD subscription unavailable', error);
        return () => {};
      }
    };

    const offStatus = attach(window.captions?.onStatus, (next) =>
      setStatus(next as SessionStatus),
    );
    const offMetrics = attach(window.captions?.onMetrics, (next) =>
      setMetrics(next as unknown as SessionMetrics),
    );
    const offDock = attach(window.captions?.onSessionHudDock, (next) =>
      setDockEdge((next as { edge: string | null })?.edge ?? null),
    );
    // Hover comes from the main process, which watches the cursor. The renderer
    // cannot see it: the pill is a drag region, and on Windows those are
    // non-client areas that receive no mouse events at all. The pointer handlers
    // below stay as a second signal for platforms where they do fire.
    const offHover = attach(window.captions?.onSessionHudHover, (next) => {
      const wanted = Boolean((next as { expanded?: boolean })?.expanded);
      if (collapseTimer.current !== null) {
        window.clearTimeout(collapseTimer.current);
        collapseTimer.current = null;
      }
      lastRequested.current = wanted;
      setExpanded(wanted);
    });
    return () => {
      offStatus();
      offMetrics();
      offDock();
      offHover();
    };
  }, []);

  useEffect(() => {
    if (lastRequested.current === expanded) return;
    lastRequested.current = expanded;
    // Same reasoning: if this channel is unavailable the pill stays whatever size
    // the main process last gave it rather than crashing on hover.
    try {
      void window.captions?.setSessionHudExpanded?.(expanded);
    } catch (error) {
      console.warn('[Twinscript] session HUD resize unavailable', error);
    }
  }, [expanded]);

  const live = status.state === 'running' || status.state === 'connected';
  const elapsed = formatElapsed(Number(metrics?.elapsedMs) || 0);
  const spend = Number(metrics?.totalUsd);
  const budget = Number(metrics?.budgetUsd);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await window.captions?.stopSession?.();
    } finally {
      // Left true: the window is hidden by the main process as soon as the
      // session reports stopped, and re-enabling first would flash the button
      // back to its normal state on the way out.
      setStopping(true);
    }
  };

  return (
    <div
      className={`session-hud${expanded ? ' is-expanded' : ''}${
        dockEdge ? ` is-docked is-docked-${dockEdge}` : ''
      }`}
      // Pointer, not mouse: this has to work for a pen or touch as well.
      onPointerEnter={() => requestExpanded(true)}
      onPointerLeave={() => requestExpanded(false)}
      // A press anywhere in the pill means the operator is using it, so hold it
      // open even if the window shifts under them mid-gesture.
      onPointerDown={() => requestExpanded(true)}
    >
      {/* The whole pill drags, and the buttons opt out. `user-select: none` in
          the stylesheet is what stops a press turning into a text selection,
          which is the bug that made the camera window nearly immovable. */}
      <div className="session-hud__grip" aria-hidden="true" />

      <span className="session-hud__status">
        <i className={`session-hud__dot${live ? ' is-live' : ''}`} aria-hidden="true" />
        <strong className="session-hud__elapsed">{elapsed}</strong>
        {expanded && Number.isFinite(spend) && (
          <span className="session-hud__spend">
            ${spend.toFixed(2)}
            {Number.isFinite(budget) && budget > 0 && (
              <em> / ${budget.toFixed(2)}</em>
            )}
          </span>
        )}
      </span>

      {/* Rendered only when expanded, so a collapsed pill has no clickable Stop
          to catch a stray click at a screen edge. */}
      {expanded && (
        <button
          type="button"
          className="session-hud__stop"
          disabled={stopping}
          // Kept open while the pointer is on the button itself, so a resize
          // cannot pull it out from under the click.
          onPointerEnter={() => requestExpanded(true)}
          onPointerDown={() => requestExpanded(true)}
          onClick={() => void stop()}
        >
          <Square size={11} strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
          {stopping ? 'Stopping…' : 'Stop session'}
        </button>
      )}
    </div>
  );
}
