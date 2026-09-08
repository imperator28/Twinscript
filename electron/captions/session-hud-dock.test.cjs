// Geometry for the floating session HUD.
//
// The HUD is the answer to a session that cannot be stopped: the overlays and the
// camera stage are always-on-top and can cover the control window entirely, and
// Stop lived only in there. Everything about where it sits is pure so it can be
// checked without a screen.
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COLLAPSED,
  EXPANDED,
  PEEK,
  initialBounds,
  resolveDockEdge,
  anchoredBounds,
} = require('./session-hud-dock');

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
// A second monitor placed left of and above the primary, to catch anything that
// assumes the work area starts at 0,0.
const OFFSET_AREA = { x: -1920, y: -200, width: 1600, height: 900 };

test('opens at the top centre of the work area', () => {
  const bounds = initialBounds({ workArea: WORK_AREA });
  assert.equal(bounds.width, COLLAPSED.width);
  assert.equal(bounds.x + bounds.width / 2, WORK_AREA.width / 2);
  // Top, because the overlays occupy the lower screen - opening down there would
  // put the HUD under the windows it exists to escape.
  assert.ok(bounds.y < 100);
});

test('opens correctly on a monitor with negative origin', () => {
  const bounds = initialBounds({ workArea: OFFSET_AREA });
  assert.equal(
    bounds.x + bounds.width / 2,
    OFFSET_AREA.x + OFFSET_AREA.width / 2,
  );
  assert.ok(bounds.y >= OFFSET_AREA.y);
});

test('docks to the nearest edge only when released close to it', () => {
  const near = { x: 800, y: 4, width: COLLAPSED.width, height: COLLAPSED.height };
  assert.equal(resolveDockEdge({ bounds: near, workArea: WORK_AREA }), 'top');

  const middle = { x: 800, y: 500, width: COLLAPSED.width, height: COLLAPSED.height };
  assert.equal(resolveDockEdge({ bounds: middle, workArea: WORK_AREA }), null);
});

test('picks the closest edge in a corner rather than an arbitrary one', () => {
  // 4px from the left, 20px from the top: left must win.
  const corner = { x: 4, y: 20, width: COLLAPSED.width, height: COLLAPSED.height };
  assert.equal(resolveDockEdge({ bounds: corner, workArea: WORK_AREA }), 'left');
});

test('recognises the right and bottom edges from the far side', () => {
  const right = {
    x: WORK_AREA.width - COLLAPSED.width - 3,
    y: 400,
    ...COLLAPSED,
  };
  assert.equal(resolveDockEdge({ bounds: right, workArea: WORK_AREA }), 'right');

  const bottom = {
    x: 600,
    y: WORK_AREA.height - COLLAPSED.height - 2,
    ...COLLAPSED,
  };
  assert.equal(resolveDockEdge({ bounds: bottom, workArea: WORK_AREA }), 'bottom');
});

test('a docked pill keeps only the peek on screen, and comes fully back when expanded', () => {
  const parked = { x: 900, y: 0, ...COLLAPSED };

  const docked = anchoredBounds({ edge: 'top', bounds: parked, workArea: WORK_AREA });
  // Mostly above the work area, with `peek` still reachable.
  assert.equal(docked.y + docked.height, WORK_AREA.y + PEEK);

  const revealed = anchoredBounds({
    edge: 'top',
    bounds: parked,
    workArea: WORK_AREA,
    expanded: true,
  });
  assert.equal(revealed.y, WORK_AREA.y);
  assert.equal(revealed.width, EXPANDED.width);
});

test('docking to a side hides along x, not y', () => {
  const parked = { x: 0, y: 300, ...COLLAPSED };
  const docked = anchoredBounds({ edge: 'left', bounds: parked, workArea: WORK_AREA });
  assert.equal(docked.x + docked.width, WORK_AREA.x + PEEK);
  assert.equal(docked.y, 300, 'the position along the edge is the operator\'s choice');
});

test('a right-docked pill stays against the right when it expands', () => {
  const parked = { x: WORK_AREA.width - COLLAPSED.width, y: 200, ...COLLAPSED };
  const expanded = anchoredBounds({
    edge: 'right',
    bounds: parked,
    workArea: WORK_AREA,
    expanded: true,
  });
  // Flush, not pushed off the screen by the extra width.
  assert.equal(expanded.x + expanded.width, WORK_AREA.x + WORK_AREA.width);
});

test('an expanding pill grows from its centre, not its left edge', () => {
  // Anchoring the left edge made it unfurl rightwards, which reads as the window
  // sliding sideways rather than the pill opening. It also threw Stop further
  // from the cursor that was about to press it.
  const parked = { x: 700, y: 400, ...COLLAPSED };
  const centreBefore = parked.x + parked.width / 2;

  const expanded = anchoredBounds({
    edge: null,
    bounds: parked,
    workArea: WORK_AREA,
    expanded: true,
  });

  assert.equal(expanded.x + expanded.width / 2, centreBefore, 'centre held');
  assert.ok(expanded.x < parked.x, 'it opened leftwards as well as rightwards');
  assert.equal(expanded.y + expanded.height / 2, parked.y + parked.height / 2);
});

test('never leaves the work area, even expanding at the far corner', () => {
  const parked = { x: WORK_AREA.width - 10, y: WORK_AREA.height - 10, ...COLLAPSED };
  const expanded = anchoredBounds({
    edge: null,
    bounds: parked,
    workArea: WORK_AREA,
    expanded: true,
  });
  assert.ok(expanded.x + expanded.width <= WORK_AREA.x + WORK_AREA.width);
  assert.ok(expanded.y + expanded.height <= WORK_AREA.y + WORK_AREA.height);
});

test('expanded is wider than collapsed, because Stop has to fit', () => {
  assert.ok(EXPANDED.width > COLLAPSED.width);
  assert.ok(EXPANDED.height >= COLLAPSED.height);
});

test('pointerWithin recognises the cursor over the pill, with a small margin', () => {
  const { pointerWithin } = require('./session-hud-dock');
  const bounds = { x: 100, y: 50, width: 148, height: 36 };

  assert.equal(pointerWithin(bounds, { x: 150, y: 60 }), true, 'inside');
  assert.equal(pointerWithin(bounds, { x: 99, y: 60 }), true, 'just outside, within the margin');
  assert.equal(pointerWithin(bounds, { x: 60, y: 60 }), false, 'well clear');
  assert.equal(pointerWithin(bounds, { x: 150, y: 200 }), false, 'below');
});

test('pointerWithin reaches a pill docked mostly off screen', () => {
  const { pointerWithin, anchoredBounds, COLLAPSED } = require('./session-hud-dock');
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const docked = anchoredBounds({
    edge: 'top',
    bounds: { x: 900, y: 0, ...COLLAPSED },
    workArea: area,
  });
  // The sliver that remains on screen must register, or a docked HUD can never
  // be revealed again.
  assert.equal(pointerWithin(docked, { x: 950, y: 10 }), true);
});

test('pointerWithin tolerates missing bounds or cursor', () => {
  const { pointerWithin } = require('./session-hud-dock');
  assert.equal(pointerWithin(null, { x: 0, y: 0 }), false);
  assert.equal(pointerWithin({ x: 0, y: 0, width: 10, height: 10 }, null), false);
});

test('a docked pill holds its edge against a nudge', () => {
  const { UNDOCK_MARGIN } = require('./session-hud-dock');
  // Reported as "I drag it away from the border but it still sticks back". A
  // docked pill sits mostly past the edge, so its distance starts negative and a
  // small drag inward still fell inside the docking band. Docking and undocking
  // need different thresholds or there is nowhere for the undocked state to
  // rest.
  const nudged = { x: 900, y: 30, ...COLLAPSED };
  assert.equal(
    resolveDockEdge({ bounds: nudged, workArea: WORK_AREA, currentEdge: 'top' }),
    'top',
    'a nudge keeps it attached',
  );
  const dragged = { x: 900, y: UNDOCK_MARGIN + 20, ...COLLAPSED };
  assert.equal(
    resolveDockEdge({ bounds: dragged, workArea: WORK_AREA, currentEdge: 'top' }),
    null,
    'a deliberate drag lets go',
  );
});

test('an undocked pill still needs to be close to attach', () => {
  // The docking band stays tight, so a pill dropped near the middle does not
  // fly to an edge.
  const near = { x: 900, y: 20, ...COLLAPSED };
  assert.equal(resolveDockEdge({ bounds: near, workArea: WORK_AREA }), 'top');
  const notNear = { x: 900, y: 60, ...COLLAPSED };
  assert.equal(resolveDockEdge({ bounds: notNear, workArea: WORK_AREA }), null);
});

test('sliding along a docked edge does not reassign the edge', () => {
  // Dragged into the top-left corner while docked to the top, it must stay on
  // the top rather than flipping to the left and jumping.
  const corner = { x: 4, y: 6, ...COLLAPSED };
  assert.equal(
    resolveDockEdge({ bounds: corner, workArea: WORK_AREA, currentEdge: 'top' }),
    'top',
  );
});
