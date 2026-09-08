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

test('an undocked pill keeps its position when it expands', () => {
  // Growing to show Stop must not teleport a HUD the operator parked somewhere.
  const parked = { x: 700, y: 400, ...COLLAPSED };
  const expanded = anchoredBounds({
    edge: null,
    bounds: parked,
    workArea: WORK_AREA,
    expanded: true,
  });
  assert.equal(expanded.x, 700);
  assert.equal(expanded.y, 400);
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
