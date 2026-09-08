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
/**
 * How far a docked pill must be dragged before it lets go.
 *
 * Docking and undocking cannot share one threshold. A docked pill sits mostly
 * past the edge, so its measured distance to that edge starts out negative;
 * dragging it twenty pixels inward still leaves it inside a 28px band and it
 * snapped straight back - which is exactly the reported "I drag it away from the
 * border but it still sticks back". Undocking therefore needs a wider band than
 * docking, so the two states have somewhere to rest.
 */
const UNDOCK_MARGIN = 96;
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
function resolveDockEdge({
  bounds,
  workArea,
  snapMargin = SNAP_MARGIN,
  currentEdge = null,
  undockMargin = UNDOCK_MARGIN,
}) {
  const distances = edgeDistances({ bounds, workArea });
  // Already docked: hold on until dragged clear of the wider band, and hold on
  // to THIS edge rather than re-deciding, so sliding along an edge does not
  // reassign it to a nearer perpendicular one.
  if (currentEdge && distances[currentEdge] <= undockMargin) return currentEdge;
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

  // Growing keeps the pill's CENTRE, not its left edge.
  //
  // Anchoring the left edge made it unfurl to the right, which reads as the
  // window sliding sideways rather than the pill opening. Holding the centre is
  // what makes it look like it grew out of itself - and it also keeps Stop near
  // where the cursor already is instead of throwing it further away.
  const centredX = clamp(
    Math.round(bounds.x + bounds.width / 2 - size.width / 2),
    workArea.x,
    Math.max(workArea.x, maxX),
  );
  const centredY = clamp(
    Math.round(bounds.y + bounds.height / 2 - size.height / 2),
    workArea.y,
    Math.max(workArea.y, maxY),
  );

  if (!edge) {
    return { x: centredX, y: centredY, ...size };
  }

  // Along a docked edge the position is the operator's choice, so only the axis
  // parallel to that edge is re-centred; the perpendicular axis is dictated by
  // the edge itself.
  const keptX = centredX;
  const keptY = centredY;

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

/**
 * Is the cursor over this window?
 *
 * Hover for the HUD is decided in the main process from the cursor position, not
 * in the renderer from pointer events. On Windows a `-webkit-app-region: drag`
 * region is implemented as non-client hit-testing, so the renderer receives no
 * mouse events over it at all - and the whole pill is a drag region, which is
 * why hovering it revealed nothing. Clicks on the Stop button still arrive,
 * because that opts out with `no-drag`; only hover was lost.
 *
 * `margin` forgives a few pixels around the edge so a docked sliver is reachable
 * without pixel-hunting, and so the reveal does not drop out the instant the
 * cursor grazes the boundary.
 */
function pointerWithin(bounds, point, margin = 6) {
  if (!bounds || !point) return false;
  return (
    point.x >= bounds.x - margin &&
    point.x <= bounds.x + bounds.width + margin &&
    point.y >= bounds.y - margin &&
    point.y <= bounds.y + bounds.height + margin
  );
}

module.exports = {
  pointerWithin,
  UNDOCK_MARGIN,
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
