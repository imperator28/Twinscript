// Hover for the session HUD, which the main process owns.
//
// It has to: the pill is a `-webkit-app-region: drag` region, and on Windows
// those are non-client areas that deliver no mouse events to the page, so the
// renderer cannot see the cursor arrive. What the renderer CAN see is the Stop
// button, which opts out with `no-drag` - and that produced the reported bug
// where moving onto the expanded pill made it retract: leaving the button fired
// pointerleave, the renderer collapsed on its own authority, and the main
// process immediately expanded it again because the cursor was still inside.
//
// One authority, tested here.
const assert = require('node:assert/strict');
const test = require('node:test');
const { CaptionWindowManager } = require('./caption-window-manager');
const { COLLAPSED, EXPANDED } = require('./session-hud-dock');

function harness({ workArea = { x: 0, y: 0, width: 1920, height: 1040 } } = {}) {
  const sends = [];
  let cursor = { x: 0, y: 900 };

  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.bounds = {
        x: options.x ?? 0,
        y: options.y ?? 0,
        width: options.width ?? 0,
        height: options.height ?? 0,
      };
      this.visible = false;
      this.destroyed = false;
      this.handlers = new Map();
      this.webContents = {
        id: 99,
        send: (channel, payload) => sends.push({ channel, payload }),
        setWindowOpenHandler() {},
        on() {},
      };
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    loadFile() {}
    loadURL() {
      return Promise.resolve();
    }
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    once(event, handler) {
      this.handlers.set(event, handler);
    }
    getBounds() {
      return { ...this.bounds };
    }
    setBounds(next) {
      this.bounds = { ...this.bounds, ...next };
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    showInactive() {
      this.visible = true;
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
  }

  const manager = new CaptionWindowManager({
    app: { getAppPath: () => '/app', isQuitting: false },
    BrowserWindow: FakeWindow,
    screen: {
      getCursorScreenPoint: () => cursor,
      getDisplayNearestPoint: () => ({ workArea }),
      on() {},
    },
    controlWindow: { isDestroyed: () => false, webContents: { send() {} } },
    isDev: false,
    preloadPath: '/preload.js',
    settingsStore: { get: () => ({ layout: 'stacked', captionTheme: 'blueprint' }) },
  });

  return {
    manager,
    sends,
    moveCursorTo(point) {
      cursor = point;
    },
    centreOfHud() {
      const b = manager.sessionHudWindow.getBounds();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    },
  };
}

const hoverEvents = (sends) =>
  sends.filter((entry) => entry.channel === 'captions:session-hud-hover');

test('expands as soon as the cursor is over the pill', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const rig = harness();
  rig.manager.showSessionHud();
  rig.moveCursorTo(rig.centreOfHud());

  t.mock.timers.tick(130);

  assert.equal(rig.manager.sessionHudExpanded, true);
  assert.deepEqual(hoverEvents(rig.sends).at(-1).payload, { expanded: true });
  assert.equal(rig.manager.sessionHudWindow.getBounds().width, EXPANDED.width);
});

test('does not collapse the instant the cursor steps outside', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const rig = harness();
  rig.manager.showSessionHud();
  rig.moveCursorTo(rig.centreOfHud());
  t.mock.timers.tick(130);

  // Resizing moves the window's edges; a single frame outside must not collapse
  // it, or expansion and collapse chase each other.
  rig.moveCursorTo({ x: 5, y: 900 });
  t.mock.timers.tick(130);
  assert.equal(rig.manager.sessionHudExpanded, true, 'still open during the grace period');

  t.mock.timers.tick(500);
  assert.equal(rig.manager.sessionHudExpanded, false, 'collapsed once the pause elapsed');
});

test('a cursor that returns before the pause keeps the pill open', (t) => {
  // The reported bug: moving from the drag area onto the Stop button retracted
  // the pill. Whatever brief gap that produces must not close it.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const rig = harness();
  rig.manager.showSessionHud();
  rig.moveCursorTo(rig.centreOfHud());
  t.mock.timers.tick(130);

  rig.moveCursorTo({ x: 5, y: 900 });
  t.mock.timers.tick(130);
  rig.moveCursorTo(rig.centreOfHud());
  t.mock.timers.tick(1000);

  assert.equal(rig.manager.sessionHudExpanded, true);
  assert.equal(rig.manager.sessionHudWindow.getBounds().width, EXPANDED.width);
});

test('the watcher stops when the HUD is hidden', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const rig = harness();
  rig.manager.showSessionHud();
  rig.manager.hideSessionHud();
  assert.equal(rig.manager.sessionHudHoverTimer, null);

  // Nothing should be polled or sent after the session ends.
  const before = hoverEvents(rig.sends).length;
  rig.moveCursorTo(rig.centreOfHud());
  t.mock.timers.tick(1000);
  assert.equal(hoverEvents(rig.sends).length, before);
});

test('the pill opens collapsed for the next session', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const rig = harness();
  rig.manager.showSessionHud();
  rig.moveCursorTo(rig.centreOfHud());
  t.mock.timers.tick(130);
  assert.equal(rig.manager.sessionHudExpanded, true);

  rig.manager.hideSessionHud();
  assert.equal(rig.manager.sessionHudExpanded, false);
  assert.equal(rig.manager.sessionHudWindow.getBounds().width, COLLAPSED.width);
});
