/**
 * Geometry for the floating session HUD.
 *
 * The HUD exists because a running session could become impossible to stop: the
 * caption overlays and the camera stage are always-on-top, so they can cover the
 * control window completely, and the Stop control lived only inside it. The HUD
 * is a small always-on-top pill that carries the session's state and its Stop,
 * so stopping never depends on finding the main window.
 *
 * All of it is pure so the fiddly parts - snapping, anchoring, staying on the
 * work area - are testable without Electron. Nothing here touches a window.
 *
 * Two sizes, not a continuum: a collapsed pill showing status, and an expanded
 * one that adds Stop. The window is resized to the content rather than being a
 * large transparent surface, because a transparent frameless window still
 * swallows clicks over its see-through areas and would block whatever sits under
 * it.
 */

const COLLAPSED = { width: 148, height: 36 };
const EXPANDED = { width: 312, height: 44 };

/** How close to an edge a release has to be before it docks. */
const SNAP_MARGIN = 28;
/** How much of the pill stays on screen once docked. */
const PEEK = 26;
/** Gap from the work-area edge when floating rather than docked. */
const FLOAT_INSET = 16;

const EDGES = ['top', 'right', 'bottom', 'left'];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sizeFor(expanded) {
  return expanded ? { ...EXPANDED } : { ...COLLAPSED };
}

/**
 * Opening position: top centre of the work area.
 *
 * Top centre because that is where the report asked for it, and because the
 * overlays live along the bottom two thirds of the screen - starting there would
 * put the HUD underneath the very windows it exists to escape.
 */
function initialBounds({ workArea, expanded = false }) {
  const size = sizeFor(expanded);
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + FLOAT_INSET),
    ...size,
  };
}

/** Distance from each work-area edge to the matching edge of `bounds`. */
function edgeDistances({ bounds, workArea }) {
  return {
    top: bounds.y - workArea.y,
    left: bounds.x - workArea.x,
    right: workArea.x + workArea.width - (bounds.x + bounds.width),
    bottom: workArea.y + workArea.height - (bounds.y + bounds.height),
  };
}

/**
 * Which edge a release should dock to, or null to stay floating.
 *
 * The nearest edge wins, and only within `snapMargin`. Ties resolve in
 * EDGES order so the outcome is deterministic rather than dependent on object
 * key order.
 */
function resolveDockEdge({ bounds, workArea, snapMargin = SNAP_MARGIN }) {
  const distances = edgeDistances({ bounds, workArea });
  let best = null;
  for (const edge of EDGES) {
    const distance = distances[edge];
    if (distance > snapMargin) continue;
    if (best === null || distance < distances[best]) best = edge;
  }
  return best;
}

/**
 * Where the window belongs for a given dock edge and expansion.
 *
 * Docked, the pill is pushed past the edge so only `peek` remains grabbable;
 * expanding pulls it fully back on screen. Undocked, the position is preserved
 * and only kept inside the work area, so a HUD the operator parked somewhere
 * deliberately does not jump when it expands.
 */
function anchoredBounds({
  edge,
  bounds,
  workArea,
  expanded = false,
  peek = PEEK,
}) {
  const size = sizeFor(expanded);
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;

  if (!edge) {
    return {
      x: Math.round(clamp(bounds.x, workArea.x, Math.max(workArea.x, maxX))),
      y: Math.round(clamp(bounds.y, workArea.y, Math.max(workArea.y, maxY))),
      ...size,
    };
  }

  // Centre along the edge is kept from wherever the operator left it, so a HUD
  // docked at the top-right stays at the right.
  const keptX = clamp(bounds.x, workArea.x, Math.max(workArea.x, maxX));
  const keptY = clamp(bounds.y, workArea.y, Math.max(workArea.y, maxY));

  if (edge === 'top') {
    return {
      x: Math.round(keptX),
      y: Math.round(expanded ? workArea.y : workArea.y - (size.height - peek)),
      ...size,
    };
  }
  if (edge === 'bottom') {
    const flush = workArea.y + workArea.height - size.height;
    return {
      x: Math.round(keptX),
      y: Math.round(expanded ? flush : flush + (size.height - peek)),
      ...size,
    };
  }
  if (edge === 'left') {
    return {
      x: Math.round(expanded ? workArea.x : workArea.x - (size.width - peek)),
      y: Math.round(keptY),
      ...size,
    };
  }
  const flushX = workArea.x + workArea.width - size.width;
  return {
    x: Math.round(expanded ? flushX : flushX + (size.width - peek)),
    y: Math.round(keptY),
    ...size,
  };
}

module.exports = {
  COLLAPSED,
  EXPANDED,
  SNAP_MARGIN,
  PEEK,
  FLOAT_INSET,
  initialBounds,
  resolveDockEdge,
  anchoredBounds,
  sizeFor,
};
