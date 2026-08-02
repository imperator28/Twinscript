const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_GEOMETRY,
  computeOverlayBounds,
} = require('./overlay-layout');
const { projectForAudience } = require('./caption-domain');
const { CaptionWindowManager } = require('./caption-window-manager');

const FULL_HD = { x: 0, y: 0, width: 1920, height: 1080 };

function assertInside(bounds, area, label) {
  assert.ok(bounds.x >= area.x, `${label}: left edge inside work area`);
  assert.ok(bounds.y >= area.y, `${label}: top edge inside work area`);
  assert.ok(
    bounds.x + bounds.width <= area.x + area.width,
    `${label}: right edge inside work area`,
  );
  assert.ok(
    bounds.y + bounds.height <= area.y + area.height,
    `${label}: bottom edge inside work area`,
  );
  for (const value of Object.values(bounds)) {
    assert.equal(Number.isInteger(value), true, `${label}: integer bounds`);
  }
}

test('stacked overlays sit centred above the bottom margin', () => {
  const { layout, bounds } = computeOverlayBounds({
    layout: 'stacked',
    workArea: FULL_HD,
  });
  assert.equal(layout, 'stacked');
  assert.equal(bounds.en.width, DEFAULT_GEOMETRY.maxStackedWidth);
  assert.equal(bounds.zh.width, DEFAULT_GEOMETRY.maxStackedWidth);
  assert.equal(bounds.en.x, bounds.zh.x);
  assert.equal(bounds.en.x, Math.floor((1920 - 1120) / 2));
  // Chinese overlay anchored to the bottom margin, English one gap above it.
  assert.equal(
    bounds.zh.y + bounds.zh.height,
    1080 - DEFAULT_GEOMETRY.margin,
  );
  assert.equal(
    bounds.zh.y - (bounds.en.y + bounds.en.height),
    DEFAULT_GEOMETRY.gap,
  );
  assertInside(bounds.en, FULL_HD, 'en');
  assertInside(bounds.zh, FULL_HD, 'zh');
});

test('side-by-side splits the work area evenly on a wide display', () => {
  const { layout, bounds } = computeOverlayBounds({
    layout: 'side-by-side',
    workArea: FULL_HD,
  });
  assert.equal(layout, 'side-by-side');
  assert.equal(bounds.en.y, bounds.zh.y);
  assert.equal(bounds.en.width, bounds.zh.width);
  assert.equal(bounds.zh.x - (bounds.en.x + bounds.en.width), DEFAULT_GEOMETRY.gap);
  assertInside(bounds.en, FULL_HD, 'en');
  assertInside(bounds.zh, FULL_HD, 'zh');
});

test('a display narrower than the threshold falls back to stacked', () => {
  const narrow = { x: 0, y: 0, width: 1000, height: 800 };
  const { layout, bounds } = computeOverlayBounds({
    layout: 'side-by-side',
    workArea: narrow,
  });
  assert.equal(layout, 'stacked');
  assert.equal(bounds.en.x, bounds.zh.x);
  assertInside(bounds.en, narrow, 'en');
});

test('a taskbar on any edge keeps the overlays inside the work area', () => {
  // Windows reports the taskbar as an inset on `workArea`, so each edge shows up
  // as a different origin or extent.
  const areas = {
    bottom: { x: 0, y: 0, width: 2560, height: 1392 },
    top: { x: 0, y: 48, width: 2560, height: 1392 },
    left: { x: 72, y: 0, width: 2488, height: 1440 },
    right: { x: 0, y: 0, width: 2488, height: 1440 },
  };
  for (const [edge, area] of Object.entries(areas)) {
    for (const layout of ['stacked', 'side-by-side']) {
      const { bounds } = computeOverlayBounds({ layout, workArea: area });
      assertInside(bounds.en, area, `${edge}/${layout}/en`);
      assertInside(bounds.zh, area, `${edge}/${layout}/zh`);
    }
  }
});

test('a secondary monitor at negative coordinates is handled', () => {
  // A display placed to the left of the primary reports a negative x origin;
  // the overlays must land on that monitor, not near the desktop origin.
  const left = { x: -1920, y: -300, width: 1920, height: 1080 };
  const leftBounds = computeOverlayBounds({ layout: 'stacked', workArea: left }).bounds;
  assert.ok(leftBounds.zh.x < 0, 'overlay stays on the negative-coordinate display');
  assert.ok(
    leftBounds.zh.x + leftBounds.zh.width <= 0,
    'overlay does not bleed onto the primary display',
  );
  assertInside(leftBounds.en, left, 'left/en');
  assertInside(leftBounds.zh, left, 'left/zh');

  // A display stacked entirely above the primary puts both overlays at negative
  // y as well.
  const above = { x: 0, y: -1080, width: 1920, height: 1080 };
  const aboveBounds = computeOverlayBounds({ layout: 'stacked', workArea: above }).bounds;
  assert.ok(aboveBounds.en.y < 0 && aboveBounds.zh.y < 0);
  assertInside(aboveBounds.en, above, 'above/en');
  assertInside(aboveBounds.zh, above, 'above/zh');
});

test('a short work area shrinks the overlays instead of pushing one off-screen', () => {
  const area = { x: 0, y: 0, width: 1920, height: 300 };
  const { bounds } = computeOverlayBounds({ layout: 'stacked', workArea: area });
  assert.ok(
    bounds.en.height < DEFAULT_GEOMETRY.stackedHeight,
    'height reduced to fit',
  );
  assert.equal(bounds.en.height, bounds.zh.height);
  assertInside(bounds.en, area, 'en');
  assertInside(bounds.zh, area, 'zh');
});

test('a tiny work area still produces usable integer bounds', () => {
  for (const area of [
    { x: 0, y: 0, width: 320, height: 240 },
    { x: 0, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 0 },
  ]) {
    const { bounds } = computeOverlayBounds({ layout: 'stacked', workArea: area });
    for (const audience of ['en', 'zh']) {
      assert.ok(bounds[audience].width > 0, 'positive width');
      assert.ok(bounds[audience].height > 0, 'positive height');
      for (const value of Object.values(bounds[audience])) {
        assert.equal(Number.isInteger(value), true);
      }
    }
  }
});

test('a missing work area does not throw', () => {
  const { bounds } = computeOverlayBounds({});
  assert.ok(bounds.en.width > 0);
  assert.ok(bounds.zh.height > 0);
});

// ---------------------------------------------------------------------------
// CaptionWindowManager integration
// ---------------------------------------------------------------------------

function fakeManager({
  workArea = FULL_HD,
  settings = {},
  persistDelayMs = 5,
  fallbackDelayMs = 5,
  cameraFramePublisher = null,
  nativeCameraSupervisor = null,
} = {}) {
  const displayHandlers = new Map();
  const created = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.bounds = null;
      this.destroyed = false;
      this.visible = Boolean(options.show);
      this.handlers = new Map();
      this.webHandlers = new Map();
      this.sent = [];
      this.webContents = {
        id: created.length + 1,
        setWindowOpenHandler() {},
        on: (event, handler) => this.webHandlers.set(event, handler),
        removeListener: (event) => this.webHandlers.delete(event),
        send: (channel, payload) => this.sent.push({ channel, payload }),
        setFrameRate: (value) => { this.frameRate = value; },
        startPainting: () => { this.painting = true; },
        stopPainting: () => { this.painting = false; },
      };
      created.push(this);
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    loadURL() {}
    loadFile() {}
    on(event, handler) {
      this.handlers.set(event, handler);
    }
    setBounds(bounds) {
      this.bounds = bounds;
    }
    getBounds() {
      return this.bounds;
    }
    setBackgroundColor(color) {
      this.backgroundColor = color;
    }
    setAspectRatio(ratio) {
      this.aspectRatio = ratio;
    }
    setTitle(title) {
      this.title = title;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    showInactive() {
      this.visible = true;
      this.handlers.get('show')?.();
    }
    show() {
      this.shown = true;
      this.visible = true;
      this.handlers.get('show')?.();
    }
    focus() {
      this.focused = true;
    }
    hide() {
      this.visible = false;
      this.handlers.get('hide')?.();
    }
    destroy() {
      this.destroyed = true;
      this.visible = false;
    }
  }
  const broadcasts = [];
  const savedSettings = {
    layout: 'stacked',
    captionTheme: 'blueprint',
    captionOverlayHeight: null,
    ...settings,
  };
  const settingsWrites = [];
  const settingsStore = {
    get: () => ({ ...savedSettings }),
    set: (patch) => {
      Object.assign(savedSettings, patch);
      settingsWrites.push(patch);
      return { ...savedSettings };
    },
  };
  const manager = new CaptionWindowManager({
    app: { getAppPath: () => '/app', isQuitting: false },
    BrowserWindow: FakeWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayNearestPoint: () => ({ workArea: manager.currentWorkArea }),
      on: (event, handler) => displayHandlers.set(event, handler),
    },
    controlWindow: {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => broadcasts.push({ channel, payload }) },
    },
    isDev: false,
    preloadPath: '/preload.js',
    settingsStore,
    persistDelayMs,
    fallbackDelayMs,
    cameraFramePublisher,
    nativeCameraSupervisor,
  });
  manager.currentWorkArea = workArea;
  return {
    manager,
    displayHandlers,
    broadcasts,
    created,
    savedSettings,
    settingsWrites,
  };
}

test('creating the overlays positions them and subscribes to display changes', () => {
  const { manager, displayHandlers } = fakeManager();
  manager.createAll();

  assert.deepEqual(
    [...displayHandlers.keys()].sort(),
    ['display-added', 'display-metrics-changed', 'display-removed'],
  );
  for (const audience of ['en', 'zh']) {
    assertInside(manager.captionWindows.get(audience).bounds, FULL_HD, audience);
  }
});

test('virtual-camera mode creates its capture stage during window startup', () => {
  const { manager, created } = fakeManager({
    settings: { outputMode: 'virtual-camera' },
  });

  manager.createAll();

  assert.equal(created.length, 3);
  assert.equal(manager.cameraStageWindow, created[2]);
  assert.equal(manager.cameraStageWindow.shown, true);
});

test('preview visibility reflects both overlay windows and the camera stage', () => {
  const { manager, broadcasts } = fakeManager();
  manager.createAll();

  assert.deepEqual(manager.previewVisibility(), {
    overlaysVisible: false,
    cameraStageVisible: false,
  });

  manager.showAll();
  assert.deepEqual(manager.previewVisibility(), {
    overlaysVisible: true,
    cameraStageVisible: false,
  });

  manager.captionWindows.get('en').hide();
  assert.deepEqual(manager.previewVisibility(), {
    overlaysVisible: false,
    cameraStageVisible: false,
  });
  assert.deepEqual(broadcasts.at(-1), {
    channel: 'captions:preview-visibility',
    payload: { overlaysVisible: false, cameraStageVisible: false },
  });
});

test('selected output shows only its matching native window family', () => {
  const { manager, broadcasts } = fakeManager();
  manager.createAll();

  manager.outputMode = 'virtual-camera';
  assert.deepEqual(manager.applySelectedOutput(), {
    overlaysVisible: false,
    cameraStageVisible: true,
  });

  manager.outputMode = 'overlays';
  assert.deepEqual(manager.applySelectedOutput(), {
    overlaysVisible: true,
    cameraStageVisible: false,
  });
  assert.deepEqual(broadcasts.at(-1), {
    channel: 'captions:preview-visibility',
    payload: { overlaysVisible: true, cameraStageVisible: false },
  });
});

test('a display change repositions the overlays onto the new work area', () => {
  const { manager, displayHandlers } = fakeManager();
  manager.createAll();

  const smaller = { x: 0, y: 0, width: 1366, height: 700 };
  manager.currentWorkArea = smaller;
  displayHandlers.get('display-metrics-changed')();

  for (const audience of ['en', 'zh']) {
    assertInside(manager.captionWindows.get(audience).bounds, smaller, audience);
  }
});

test('display subscriptions are installed once', () => {
  const { manager } = fakeManager();
  let subscriptions = 0;
  manager.screen.on = () => {
    subscriptions += 1;
  };
  manager.watchDisplays();
  manager.watchDisplays();
  assert.equal(subscriptions, 3);
});

test('a side-by-side request survives a display that cannot show it', () => {
  const { manager, broadcasts } = fakeManager({
    workArea: { x: 0, y: 0, width: 1000, height: 800 },
  });
  manager.createAll();

  // Narrow display: the request is honored as far as possible and reported
  // honestly, but the operator's choice is remembered.
  assert.deepEqual(manager.applyLayout('side-by-side'), { layout: 'stacked' });
  assert.equal(manager.layout, 'side-by-side');
  assert.equal(
    broadcasts.at(-1).payload.layout,
    'stacked',
    'the control window is told what is actually on screen',
  );

  // Moving to a wide display honors the remembered request without asking again.
  manager.currentWorkArea = FULL_HD;
  manager.applyLayout(manager.layout);
  assert.equal(broadcasts.at(-1).payload.layout, 'side-by-side');
  const en = manager.captionWindows.get('en').bounds;
  const zh = manager.captionWindows.get('zh').bounds;
  assert.equal(en.y, zh.y, 'side-by-side pair shares a baseline');
});

test('a destroyed overlay is skipped rather than crashing the layout pass', () => {
  const { manager } = fakeManager();
  manager.createAll();
  manager.captionWindows.get('en').destroyed = true;
  assert.doesNotThrow(() => manager.applyLayout('stacked'));
});

test('a shared height grows equal stacked overlays upward from a fixed lower edge', () => {
  const initial = computeOverlayBounds({
    layout: 'stacked',
    workArea: FULL_HD,
  }).bounds;
  const grown = computeOverlayBounds({
    layout: 'stacked',
    workArea: FULL_HD,
    sharedHeight: 230,
  }).bounds;

  assert.equal(grown.en.height, 230);
  assert.equal(grown.zh.height, 230);
  assert.equal(
    grown.zh.y + grown.zh.height,
    initial.zh.y + initial.zh.height,
    'lower edge stays anchored while the top moves upward',
  );
  assert.equal(grown.zh.y - (grown.en.y + grown.en.height), DEFAULT_GEOMETRY.gap);
  assertInside(grown.en, FULL_HD, 'grown/en');
  assertInside(grown.zh, FULL_HD, 'grown/zh');
});

test('balanced caps constrain the shared height by layout', () => {
  const stacked = computeOverlayBounds({
    layout: 'stacked',
    workArea: FULL_HD,
    sharedHeight: 900,
  }).bounds;
  assert.equal(stacked.en.height, stacked.zh.height);
  assert.equal(
    stacked.en.height,
    Math.floor((FULL_HD.height * 0.45 - DEFAULT_GEOMETRY.gap) / 2),
  );
  assert.ok(
    stacked.en.height + stacked.zh.height + DEFAULT_GEOMETRY.gap <=
      Math.floor(FULL_HD.height * 0.45),
  );

  const { bounds } = computeOverlayBounds({
    layout: 'side-by-side',
    workArea: FULL_HD,
    sharedHeight: 900,
  });
  assert.equal(bounds.en.height, bounds.zh.height);
  assert.equal(bounds.en.height, Math.floor(FULL_HD.height * 0.33));
  assert.ok(bounds.en.height <= Math.floor(FULL_HD.height * 0.33));
  assert.equal(
    bounds.en.y + bounds.en.height,
    bounds.zh.y + bounds.zh.height,
  );
});

test('the window manager waits for both audiences and uses the larger natural height', () => {
  const { manager } = fakeManager();
  manager.createAll();
  assert.equal(manager.reportContentHeight('en', 180, 0), 180);
  assert.equal(manager.captionWindows.get('en').bounds.height, 142);
  assert.equal(manager.reportContentHeight('zh', 230, 0), 230);
  assert.equal(manager.captionWindows.get('en').bounds.height, 230);
  assert.equal(manager.captionWindows.get('zh').bounds.height, 230);
  assert.equal(manager.reportContentHeight('zh', Number.NaN, 0), null);
});

test('history reset rejects stale measurements and returns to automatic sizing', () => {
  const { manager, savedSettings } = fakeManager({
    settings: { captionOverlayHeight: 200 },
  });
  manager.createAll();
  assert.equal(manager.captionWindows.get('en').bounds.height, 200);

  const next = manager.resetAutoSize();
  assert.equal(next.captionOverlayHeight, null);
  assert.equal(savedSettings.captionOverlayHeight, null);
  assert.equal(manager.autoSizeGeneration, 1);
  assert.equal(manager.reportContentHeight('en', 190, 0), null);
  manager.reportContentHeight('en', 190, 1);
  manager.reportContentHeight('zh', 210, 1);
  assert.equal(manager.captionWindows.get('en').bounds.height, 210);
});

test('content grows above the manual height and settles back only to that floor', () => {
  // A dragged height is a floor, not a cap. Before this, any manual resize
  // froze the overlay: raising visible history from 3 to 10 entries clipped the
  // extra lines instead of growing the window.
  const { manager } = fakeManager({ settings: { captionOverlayHeight: 180 } });
  manager.createAll();
  assert.equal(manager.captionWindows.get('en').bounds.height, 180);

  // Taller content grows both overlays past the dragged floor.
  manager.reportContentHeight('en', 230, manager.autoSizeGeneration);
  manager.reportContentHeight('zh', 215, manager.autoSizeGeneration);
  assert.equal(manager.captionWindows.get('en').bounds.height, 230);
  assert.equal(manager.captionWindows.get('zh').bounds.height, 230);

  // Shorter content settles back to the floor, not to the measurement.
  manager.reportContentHeight('en', 120, manager.autoSizeGeneration);
  manager.reportContentHeight('zh', 130, manager.autoSizeGeneration);
  assert.equal(manager.captionWindows.get('en').bounds.height, 180);
  assert.equal(manager.captionWindows.get('zh').bounds.height, 180);

  // Growth still respects the work-area cap: stacked overlays may not exceed
  // 45% of the display between them.
  const cap = Math.floor((FULL_HD.height * 0.45 - DEFAULT_GEOMETRY.gap) / 2);
  manager.reportContentHeight('en', cap + 400, manager.autoSizeGeneration);
  manager.reportContentHeight('zh', cap + 400, manager.autoSizeGeneration);
  assert.equal(manager.captionWindows.get('en').bounds.height, cap);
});

test('a visible-history change re-measures without discarding the manual floor', () => {
  const { manager } = fakeManager({
    settings: { captionOverlayHeight: 200 },
  });
  manager.createAll();

  const next = manager.resetContentMeasurements();
  assert.equal(manager.manualHeight, 200, 'the dragged floor survives');
  assert.equal(next.captionOverlayHeight, 200);
  assert.equal(manager.automaticHeight, null, 'measurements are invalidated');
  assert.equal(manager.autoSizeGeneration, 1);
  assert.equal(manager.captionWindows.get('en').bounds.height, 200);

  // Stale-generation reports are still rejected.
  assert.equal(manager.reportContentHeight('en', 230, 0), null);
  manager.reportContentHeight('en', 230, 1);
  manager.reportContentHeight('zh', 220, 1);
  assert.equal(manager.captionWindows.get('en').bounds.height, 230);
});

test('user resizing either panel synchronizes and persists the shared height', async () => {
  const { manager, savedSettings } = fakeManager();
  manager.createAll();
  const en = manager.captionWindows.get('en');
  const zh = manager.captionWindows.get('zh');

  en.handlers.get('will-resize')({}, { ...en.bounds, height: 210 });
  assert.equal(en.bounds.height, 210);
  assert.equal(zh.bounds.height, 210);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(savedSettings.captionOverlayHeight, 210);

  zh.handlers.get('will-resize')({}, { ...zh.bounds, height: 190 });
  assert.equal(en.bounds.height, 190);
  assert.equal(zh.bounds.height, 190);
});

test('theme settings update each native caption-window background', () => {
  const { manager, created } = fakeManager();
  manager.createAll();
  assert.equal(created[0].options.backgroundColor, '#0D47A1');
  assert.equal(created[1].options.backgroundColor, '#E3F2FD');

  manager.applySettings({ captionTheme: 'red-blue' });
  assert.equal(created[0].backgroundColor, '#164E87');
  assert.equal(created[1].backgroundColor, '#8B2635');
});

test('camera stage is a secure fixed-ratio preview fitted to the display', () => {
  const { manager, created } = fakeManager();
  manager.createAll();

  const stage = manager.showCameraStage();

  assert.equal(created.length, 3);
  // The preview opens inside the work area rather than at a full 1920x1080,
  // which covered three quarters of a 2560-wide desktop and read as the app
  // taking over the screen. The aspect ratio is still locked 16:9 and the
  // offscreen output window remains exactly 1920x1080 (asserted separately).
  assert.ok(stage.options.width <= Math.floor(FULL_HD.width * 0.6));
  assert.ok(stage.options.height <= Math.floor(FULL_HD.height * 0.6));
  assert.equal(
    Math.round((stage.options.width * 9) / 16),
    stage.options.height,
  );
  assert.equal(stage.aspectRatio, 16 / 9);
  assert.equal(stage.options.frame, false);
  assert.equal(stage.options.transparent, false);
  assert.equal(stage.options.skipTaskbar, false);
  assert.equal(stage.options.backgroundColor, '#05070A');
  assert.equal(stage.options.title, 'Twinscript Camera Stage');
  assert.equal(stage.aspectRatio, 16 / 9);
  assert.equal(stage.shown, true);
  assert.equal(stage.focused, true);
  assert.equal(manager.cameraStageWindow, stage);

  let titleUpdatePrevented = false;
  stage.webHandlers.get('page-title-updated')({
    preventDefault: () => {
      titleUpdatePrevented = true;
    },
  });
  assert.equal(titleUpdatePrevented, true);
  assert.equal(stage.title, 'Twinscript Camera Stage');
});

test('only the preview surface can render operator chrome', () => {
  // Both camera windows load the same renderer. The offscreen one's pixels
  // become the camera feed, so it must declare a role that suppresses the hover
  // bar; virtual-camera.md forbids controls in the feed.
  const { manager } = fakeManager();
  manager.createAll();
  manager.createCameraStageWindow();
  manager.createCameraOutputWindow();

  const camera = (manager.loadedSurfaces || []).filter((query) =>
    query.startsWith('camera-stage'),
  );
  assert.equal(camera.length, 2, 'a preview and an offscreen output surface');
  assert.equal(
    camera.filter((query) => query === 'camera-stage&role=preview').length,
    1,
  );
  assert.equal(
    camera.filter((query) => query === 'camera-stage&role=output').length,
    1,
  );
  // No camera surface may load without a role: the renderer only shows chrome
  // for an explicit preview, so an unlabelled surface would silently lose it.
  assert.equal(camera.every((query) => query.includes('role=')), true);
});

test('camera stage is lazy, reused, and closing it hides instead of destroying it', () => {
  const { manager, created } = fakeManager();
  manager.createAll();
  assert.equal(created.length, 2);

  const first = manager.showCameraStage();
  const second = manager.showCameraStage();
  assert.equal(first, second);
  assert.equal(created.length, 3);

  let prevented = false;
  let hidden = false;
  first.hide = () => {
    hidden = true;
  };
  first.handlers.get('close')({
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(hidden, true);
});

test('native offscreen output continues when the optional preview is hidden', async () => {
  const calls = [];
  const cameraFramePublisher = {
    start: (window) => { calls.push({ action: 'start', window }); },
    stop: () => { calls.push({ action: 'stop' }); },
  };
  const { manager, created } = fakeManager({ cameraFramePublisher });
  manager.createAll();

  manager.outputMode = 'virtual-camera';
  manager.applySelectedOutput();
  await manager.cameraOutputLifecycle;
  assert.equal(created.length, 4, 'two overlays, preview, and offscreen output');
  assert.equal(manager.cameraOutputWindow.options.show, false);
  assert.equal(manager.cameraOutputWindow.options.webPreferences.offscreen, true);
  assert.deepEqual(calls.map(({ action }) => action), ['start']);

  manager.hideCameraStage();
  assert.deepEqual(
    calls.map(({ action }) => action),
    ['start'],
    'hiding preview must not stop production frames',
  );

  manager.outputMode = 'overlays';
  manager.applySelectedOutput();
  await manager.cameraOutputLifecycle;
  assert.deepEqual(calls.map(({ action }) => action), ['start', 'stop']);
  assert.equal(manager.cameraOutputWindow, null);
});

test('native companion follows output mode without coupling to the caption session', async () => {
  const calls = [];
  const cameraFramePublisher = {
    start: async () => { calls.push('frames:start'); },
    stop: async () => { calls.push('frames:stop'); },
  };
  const nativeCameraSupervisor = {
    refresh: async () => ({
      state: 'stopped', supported: true, installed: true,
    }),
    start: async () => {
      calls.push('companion:start');
      return { state: 'starting', supported: true, installed: true };
    },
    stop: async () => { calls.push('companion:stop'); },
  };
  const { manager } = fakeManager({
    cameraFramePublisher,
    nativeCameraSupervisor,
  });
  manager.createAll();
  manager.outputMode = 'virtual-camera';
  manager.applySelectedOutput();
  await manager.cameraOutputLifecycle;
  assert.deepEqual(calls, ['frames:start', 'companion:start']);

  manager.outputMode = 'overlays';
  manager.applySelectedOutput();
  await manager.cameraOutputLifecycle;
  assert.deepEqual(calls, [
    'frames:start',
    'companion:start',
    'frames:stop',
    'companion:stop',
  ]);
});

test('a rapid switch back to overlays cannot leave a stale companion running', async () => {
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const calls = [];
  const cameraFramePublisher = {
    start: async () => { calls.push('frames:start'); },
    stop: async () => { calls.push('frames:stop'); },
  };
  const nativeCameraSupervisor = {
    refresh: async () => {
      await refreshGate;
      return { state: 'stopped', supported: true, installed: true };
    },
    start: async () => { calls.push('companion:start'); return { state: 'starting' }; },
    stop: async () => { calls.push('companion:stop'); },
  };
  const { manager } = fakeManager({ cameraFramePublisher, nativeCameraSupervisor });
  manager.createAll();
  manager.outputMode = 'virtual-camera';
  manager.applySelectedOutput();
  manager.outputMode = 'overlays';
  manager.applySelectedOutput();
  releaseRefresh();
  await manager.cameraOutputLifecycle;

  assert.deepEqual(calls, ['frames:stop', 'companion:stop']);
  assert.equal(manager.cameraOutputWindow, null);
  assert.equal(manager.cameraOutputStarted, false);
});

test('virtual-overlay-virtual churn starts only the final live offscreen window', async () => {
  const startedWindows = [];
  const cameraFramePublisher = {
    start: async (window) => { startedWindows.push(window); },
    stop: async () => {},
  };
  const nativeCameraSupervisor = {
    refresh: async () => ({ state: 'stopped', supported: true, installed: true }),
    start: async () => ({ state: 'starting', supported: true, installed: true }),
    stop: async () => {},
  };
  const { manager } = fakeManager({ cameraFramePublisher, nativeCameraSupervisor });
  manager.createAll();
  manager.outputMode = 'virtual-camera';
  manager.applySelectedOutput();
  manager.outputMode = 'overlays';
  manager.applySelectedOutput();
  manager.outputMode = 'virtual-camera';
  manager.applySelectedOutput();
  await manager.cameraOutputLifecycle;

  assert.equal(startedWindows.length, 1);
  assert.equal(startedWindows[0], manager.cameraOutputWindow);
  assert.equal(startedWindows[0].isDestroyed(), false);
  assert.equal(manager.cameraOutputStarted, true);
});

test('accelerated output-mode soak leaves no offscreen renderer or companion alive', async () => {
  let companionRunning = false;
  const cameraFramePublisher = { start: async () => {}, stop: async () => {} };
  const nativeCameraSupervisor = {
    refresh: async () => ({ state: 'stopped', supported: true, installed: true }),
    start: async () => { companionRunning = true; return { state: 'starting' }; },
    stop: async () => { companionRunning = false; },
  };
  const { manager, created } = fakeManager({
    cameraFramePublisher,
    nativeCameraSupervisor,
  });
  manager.createAll();
  for (let cycle = 0; cycle < 50; cycle += 1) {
    manager.outputMode = 'virtual-camera';
    manager.applySelectedOutput();
    await manager.cameraOutputLifecycle;
    manager.outputMode = 'overlays';
    manager.applySelectedOutput();
    await manager.cameraOutputLifecycle;
  }

  const liveOffscreen = created.filter(
    (window) => window.options.webPreferences?.offscreen && !window.isDestroyed(),
  );
  assert.equal(liveOffscreen.length, 0);
  assert.equal(manager.cameraOutputWindow, null);
  assert.equal(companionRunning, false);
});

test('camera stage receives paired caption projections and shared session state', () => {
  const { manager } = fakeManager();
  manager.createAll();
  const stage = manager.showCameraStage();
  const event = {
    id: 'line-1',
    sessionId: 'session-1',
    sequence: 1,
    sourceChannel: 'microphone',
    sourceLanguage: 'en',
    sourceText: 'hello',
    sourceStartedAt: 1,
    status: 'final',
    english: { text: 'hello', status: 'final', revision: 1 },
    chinese: { text: '你好', status: 'final', revision: 1 },
  };

  manager.publishCaption(event);
  manager.broadcast('captions:status', {
    state: 'running',
    sessionId: 'session-1',
  });

  assert.deepEqual(
    stage.sent.filter(({ channel }) => channel === 'captions:audience-event'),
    [
      {
        channel: 'captions:audience-event',
        payload: projectForAudience(event, 'en'),
      },
      {
        channel: 'captions:audience-event',
        payload: projectForAudience(event, 'zh'),
      },
    ],
  );
  assert.deepEqual(stage.sent.at(-1), {
    channel: 'captions:status',
    payload: { state: 'running', sessionId: 'session-1' },
  });
});

test('output-mode settings select either overlays or the camera stage', () => {
  const { manager } = fakeManager();
  manager.createAll();
  let overlaysHidden = 0;
  let overlaysShown = 0;
  manager.hideAll = () => {
    overlaysHidden += 1;
  };
  manager.showAll = () => {
    overlaysShown += 1;
  };

  manager.applySettings({ outputMode: 'virtual-camera' });
  assert.equal(overlaysHidden, 1);
  assert.equal(manager.cameraStageWindow.shown, true);

  let stageHidden = 0;
  manager.cameraStageWindow.hide = () => {
    stageHidden += 1;
  };
  manager.applySettings({ outputMode: 'overlays' });
  assert.equal(stageHidden, 1);
  assert.equal(overlaysShown, 1, 'switching modes previews the selected output');
});

test('camera-stage snapshot backfills a mode switch made during a live session', () => {
  const { manager } = fakeManager();
  manager.createAll();
  const event = {
    id: 'line-1',
    sessionId: 'session-1',
    sequence: 1,
    sourceChannel: 'microphone',
    sourceLanguage: 'en',
    sourceText: 'hello',
    sourceStartedAt: 1,
    status: 'final',
    english: { text: 'hello', status: 'final', revision: 1 },
    chinese: { text: '你好', status: 'final', revision: 1 },
  };

  manager.publishStatus({ state: 'running', sessionId: 'session-1' });
  manager.publishCaption(event);

  assert.deepEqual(manager.cameraStageSnapshot(), {
    status: { state: 'running', sessionId: 'session-1' },
    captions: [
      projectForAudience(event, 'en'),
      projectForAudience(event, 'zh'),
    ],
  });
});
