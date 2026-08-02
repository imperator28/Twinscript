const path = require('path');
const CAPTION_THEMES = require('../../shared/caption-themes.json');
const { projectForAudience } = require('./caption-domain');
const { computeOverlayBounds } = require('./overlay-layout');

const AUDIENCES = ['en', 'zh'];
const DEFAULT_THEME = CAPTION_THEMES.find((theme) => theme.id === 'blueprint');

function themeById(id) {
  return CAPTION_THEMES.find((theme) => theme.id === id) || DEFAULT_THEME;
}

function boundedHeight(height) {
  if (!Number.isFinite(height)) return null;
  const rounded = Math.round(height);
  return rounded >= 64 && rounded <= 2000 ? rounded : null;
}

class CaptionWindowManager {
  constructor({
    app,
    BrowserWindow,
    screen,
    controlWindow,
    isDev,
    preloadPath,
    settingsStore,
    cameraFramePublisher = null,
    nativeCameraSupervisor = null,
    fallbackDelayMs = 250,
    persistDelayMs = 180,
  }) {
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.screen = screen;
    this.controlWindow = controlWindow;
    this.isDev = isDev;
    this.preloadPath = preloadPath;
    this.settingsStore = settingsStore;
    this.cameraFramePublisher = cameraFramePublisher;
    this.nativeCameraSupervisor = nativeCameraSupervisor;
    this.fallbackDelayMs = fallbackDelayMs;
    this.persistDelayMs = persistDelayMs;
    this.captionWindows = new Map();
    this.cameraStageWindow = null;
    this.cameraOutputWindow = null;
    this.cameraOutputStarted = false;
    this.cameraOutputGeneration = 0;
    this.cameraOutputStopPromise = null;
    this.cameraOutputLifecycle = Promise.resolve();
    this.lastStatus = { state: 'ready' };
    this.cameraStageEvents = new Map();
    const settings = settingsStore?.get?.() || {};
    this.layout = settings.layout === 'side-by-side' ? 'side-by-side' : 'stacked';
    this.outputMode =
      settings.outputMode === 'virtual-camera' ? 'virtual-camera' : 'overlays';
    this.captionTheme = settings.captionTheme || 'blueprint';
    this.manualHeight = boundedHeight(settings.captionOverlayHeight);
    this.automaticHeight = null;
    this.autoSizeGeneration = 0;
    this.contentMeasurements = new Map();
    this.programmaticResizes = new Set();
    this.fallbackTimer = null;
    this.persistTimer = null;
  }

  createAll() {
    for (const audience of AUDIENCES) this.createCaptionWindow(audience);
    this.applyLayout(this.layout);
    this.watchDisplays();
    if (this.outputMode === 'virtual-camera') {
      this.hideAll();
      this.showCameraStage();
      this.startCameraOutput();
    }
  }

  watchDisplays() {
    if (this.displayWatchInstalled || typeof this.screen?.on !== 'function') return;
    this.displayWatchInstalled = true;
    const reapply = () => this.applyLayout(this.layout);
    for (const event of [
      'display-added',
      'display-removed',
      'display-metrics-changed',
    ]) {
      this.screen.on(event, reapply);
    }
  }

  targetWorkArea() {
    const display = this.screen.getDisplayNearestPoint(
      this.screen.getCursorScreenPoint(),
    );
    return display?.workArea || { x: 0, y: 0, width: 1280, height: 720 };
  }

  audienceBackground(audience) {
    return themeById(this.captionTheme).surfaces[audience].nativeBackground;
  }

  createCaptionWindow(audience) {
    const window = new this.BrowserWindow({
      width: 1040,
      height: 156,
      show: false,
      frame: false,
      transparent: false,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: this.audienceBackground(audience),
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    window.setAlwaysOnTop(true, 'screen-saver', 1);
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    window.setContentProtection(false);
    this.hardenWindow(window);
    this.loadSurface(window, `caption&audience=${audience}`);
    window.on('will-resize', (_event, nextBounds) => {
      if (this.programmaticResizes.has(audience)) return;
      this.acceptManualHeight(nextBounds?.height);
    });
    window.on('close', (event) => {
      if (!this.app.isQuitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on('show', () => this.publishPreviewVisibility());
    window.on('hide', () => this.publishPreviewVisibility());
    this.captionWindows.set(audience, window);
    return window;
  }

  createCameraStageWindow() {
    if (
      this.cameraStageWindow &&
      !this.cameraStageWindow.isDestroyed()
    ) {
      return this.cameraStageWindow;
    }
    const window = new this.BrowserWindow({
      width: 1920,
      height: 1080,
      show: false,
      frame: false,
      transparent: false,
      resizable: true,
      movable: true,
      minimizable: true,
      maximizable: true,
      fullscreenable: true,
      skipTaskbar: false,
      hasShadow: false,
      alwaysOnTop: false,
      backgroundColor: '#05070A',
      title: 'Bilingual Camera Stage',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    window.setAspectRatio(16 / 9);
    window.setContentProtection(false);
    this.hardenWindow(window);
    window.webContents.on('page-title-updated', (event) => {
      event.preventDefault();
      window.setTitle('Bilingual Camera Stage');
    });
    this.loadSurface(window, 'camera-stage');
    window.on('close', (event) => {
      if (!this.app.isQuitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on('show', () => this.publishPreviewVisibility());
    window.on('hide', () => this.publishPreviewVisibility());
    this.cameraStageWindow = window;
    return window;
  }

  createCameraOutputWindow() {
    if (
      this.cameraOutputWindow &&
      !this.cameraOutputWindow.isDestroyed()
    ) {
      return this.cameraOutputWindow;
    }
    const window = new this.BrowserWindow({
      width: 1920,
      height: 1080,
      show: false,
      frame: false,
      transparent: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#05070A',
      title: 'Bilingual Camera Output',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        offscreen: true,
      },
    });
    window.setContentProtection(false);
    this.hardenWindow(window);
    window.webContents.on('did-finish-load', () => {
      const snapshot = this.cameraStageSnapshot();
      window.webContents.send('captions:status', snapshot.status);
      for (const caption of snapshot.captions) {
        window.webContents.send('captions:audience-event', caption);
      }
    });
    this.loadSurface(window, 'camera-stage');
    this.cameraOutputWindow = window;
    return window;
  }

  startCameraOutput() {
    if (!this.cameraFramePublisher || this.cameraOutputStarted) return null;
    const generation = ++this.cameraOutputGeneration;
    this.cameraOutputStarted = true;
    const startPromise = this.cameraOutputLifecycle.catch(() => {}).then(async () => {
      if (generation !== this.cameraOutputGeneration) return;
      const window = this.createCameraOutputWindow();
      if (this.nativeCameraSupervisor) {
        const health = await this.nativeCameraSupervisor.refresh();
        if (generation !== this.cameraOutputGeneration) return;
        this.broadcastControl('captions:native-camera-health', health);
        if (
          !health.supported ||
          !health.installed ||
          health.state === 'repair-required'
        ) {
          this.cameraOutputStarted = false;
          this.destroyCameraOutputWindow();
          return;
        }
      }
      await this.cameraFramePublisher.start(window);
      if (generation !== this.cameraOutputGeneration) {
        await this.cameraFramePublisher.stop();
        return;
      }
      if (this.nativeCameraSupervisor) {
        const health = await this.nativeCameraSupervisor.start();
        if (generation !== this.cameraOutputGeneration) {
          await this.nativeCameraSupervisor.stop();
          await this.cameraFramePublisher.stop();
          return;
        }
        this.broadcastControl('captions:native-camera-health', health);
        if (health.state === 'failed' || health.state === 'repair-required') {
          this.cameraOutputStarted = false;
          await this.cameraFramePublisher.stop();
          this.destroyCameraOutputWindow();
        }
      }
    }).catch(async (error) => {
      this.cameraOutputStarted = false;
      await this.cameraFramePublisher.stop().catch(() => {});
      await this.nativeCameraSupervisor?.stop().catch(() => {});
      this.destroyCameraOutputWindow();
      this.broadcastControl('captions:native-camera-health', {
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.cameraOutputLifecycle = startPromise;
    return null;
  }

  stopCameraOutput() {
    this.cameraOutputGeneration += 1;
    this.cameraOutputStarted = false;
    const stopPromise = this.cameraOutputLifecycle.catch(() => {}).then(async () => {
      await this.cameraFramePublisher?.stop();
      await this.nativeCameraSupervisor?.stop();
    }).catch((error) => {
      this.broadcastControl('captions:native-camera-health', {
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      this.destroyCameraOutputWindow();
    });
    this.cameraOutputLifecycle = stopPromise;
    const trackedStop = stopPromise.finally(() => {
      if (this.cameraOutputStopPromise === trackedStop) {
        this.cameraOutputStopPromise = null;
      }
    });
    this.cameraOutputStopPromise = trackedStop;
    return trackedStop;
  }

  destroyCameraOutputWindow() {
    const window = this.cameraOutputWindow;
    this.cameraOutputWindow = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  showCameraStage({ notify = true } = {}) {
    const window = this.createCameraStageWindow();
    window.show();
    window.focus();
    if (notify) this.publishPreviewVisibility();
    return window;
  }

  hideCameraStage({ notify = true } = {}) {
    if (
      this.cameraStageWindow &&
      !this.cameraStageWindow.isDestroyed()
    ) {
      this.cameraStageWindow.hide();
    }
    if (notify) return this.publishPreviewVisibility();
    return this.previewVisibility();
  }

  hardenWindow(window) {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      const allowed = this.isDev
        ? url.startsWith('http://127.0.0.1:5173') ||
          url.startsWith('http://localhost:5173')
        : url.startsWith('file://');
      if (!allowed) event.preventDefault();
    });
  }

  loadSurface(window, query) {
    if (this.isDev) {
      void window.loadURL(`http://localhost:5173/?surface=${query}`);
    } else {
      void window.loadFile(path.join(this.app.getAppPath(), 'build/index.html'), {
        query: Object.fromEntries(new URLSearchParams(`surface=${query}`)),
      });
    }
  }

  showAll({ notify = true } = {}) {
    for (const window of this.captionWindows.values()) {
      window.showInactive();
      window.setAlwaysOnTop(true, 'screen-saver', 1);
    }
    if (notify) return this.publishPreviewVisibility();
    return this.previewVisibility();
  }

  hideAll({ notify = true } = {}) {
    for (const window of this.captionWindows.values()) window.hide();
    if (notify) return this.publishPreviewVisibility();
    return this.previewVisibility();
  }

  previewVisibility() {
    const overlaysVisible = AUDIENCES.every((audience) => {
      const window = this.captionWindows.get(audience);
      return window && !window.isDestroyed() && window.isVisible();
    });
    const cameraStageVisible = Boolean(
      this.cameraStageWindow &&
        !this.cameraStageWindow.isDestroyed() &&
        this.cameraStageWindow.isVisible(),
    );
    return { overlaysVisible, cameraStageVisible };
  }

  publishPreviewVisibility() {
    const snapshot = this.previewVisibility();
    this.broadcastControl('captions:preview-visibility', snapshot);
    return snapshot;
  }

  applySelectedOutput() {
    if (this.outputMode === 'virtual-camera') {
      this.hideAll({ notify: false });
      this.showCameraStage({ notify: false });
      this.startCameraOutput();
    } else {
      this.stopCameraOutput();
      this.hideCameraStage({ notify: false });
      this.showAll({ notify: false });
    }
    return this.publishPreviewVisibility();
  }

  requestedHeight() {
    return this.manualHeight ?? this.automaticHeight ?? undefined;
  }

  setWindowBounds(audience, window, bounds) {
    const current = window.getBounds?.();
    if (
      current &&
      current.x === bounds.x &&
      current.y === bounds.y &&
      current.width === bounds.width &&
      current.height === bounds.height
    ) {
      return;
    }
    this.programmaticResizes.add(audience);
    try {
      window.setBounds(bounds);
    } finally {
      this.programmaticResizes.delete(audience);
    }
  }

  applyLayout(layout = 'stacked') {
    const requested = layout === 'side-by-side' ? 'side-by-side' : 'stacked';
    const { layout: resolved, bounds } = computeOverlayBounds({
      layout: requested,
      workArea: this.targetWorkArea(),
      sharedHeight: this.requestedHeight(),
    });
    this.layout = requested;
    for (const audience of AUDIENCES) {
      const window = this.captionWindows.get(audience);
      if (window && !window.isDestroyed()) {
        this.setWindowBounds(audience, window, bounds[audience]);
      }
    }
    this.broadcastControl('captions:layout', { layout: resolved });
    return { layout: resolved };
  }

  publishCaption(event) {
    if (event.suppressed) this.cameraStageEvents.delete(event.id);
    else this.cameraStageEvents.set(event.id, event);
    this.broadcastControl('captions:event', event);
    this.presentCaption(event);
  }

  publishStatus(status) {
    if (
      status.state === 'starting' &&
      status.sessionId &&
      status.sessionId !== this.lastStatus.sessionId
    ) {
      this.cameraStageEvents.clear();
    }
    if (['stopped', 'ready', 'budget-exhausted'].includes(status.state)) {
      this.cameraStageEvents.clear();
    }
    this.lastStatus = status;
    this.broadcast('captions:status', status);
  }

  cameraStageSnapshot() {
    const events = [...this.cameraStageEvents.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    return {
      status: this.lastStatus,
      captions: events.flatMap((event) =>
        AUDIENCES.map((audience) => projectForAudience(event, audience)),
      ),
    };
  }

  presentCaption(event) {
    for (const audience of AUDIENCES) {
      const window = this.captionWindows.get(audience);
      if (window && !window.isDestroyed()) {
        window.webContents.send(
          'captions:audience-event',
          projectForAudience(event, audience),
        );
      }
    }
    if (this.cameraStageWindow && !this.cameraStageWindow.isDestroyed()) {
      for (const audience of AUDIENCES) {
        this.cameraStageWindow.webContents.send(
          'captions:audience-event',
          projectForAudience(event, audience),
        );
      }
    }
    if (this.cameraOutputWindow && !this.cameraOutputWindow.isDestroyed()) {
      for (const audience of AUDIENCES) {
        this.cameraOutputWindow.webContents.send(
          'captions:audience-event',
          projectForAudience(event, audience),
        );
      }
    }
  }

  clearFallbackTimer() {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  applyCurrentMeasurements() {
    if (this.manualHeight !== null || this.contentMeasurements.size === 0) return;
    this.automaticHeight = Math.max(...this.contentMeasurements.values());
    this.applyLayout(this.layout);
  }

  reportContentHeight(audience, height, generation) {
    const bounded = boundedHeight(height);
    if (
      !AUDIENCES.includes(audience) ||
      bounded === null ||
      !Number.isInteger(generation) ||
      generation !== this.autoSizeGeneration
    ) {
      return null;
    }
    this.contentMeasurements.set(audience, bounded);
    if (this.manualHeight !== null) return bounded;

    const availableAudiences = AUDIENCES.filter((name) => {
      const window = this.captionWindows.get(name);
      return window && !window.isDestroyed();
    });
    const complete = availableAudiences.every((name) =>
      this.contentMeasurements.has(name),
    );
    if (complete) {
      this.clearFallbackTimer();
      this.applyCurrentMeasurements();
    } else if (!this.fallbackTimer) {
      const expectedGeneration = this.autoSizeGeneration;
      this.fallbackTimer = setTimeout(() => {
        this.fallbackTimer = null;
        if (expectedGeneration === this.autoSizeGeneration) {
          this.applyCurrentMeasurements();
        }
      }, this.fallbackDelayMs);
      this.fallbackTimer.unref?.();
    }
    return bounded;
  }

  acceptManualHeight(height) {
    const bounded = boundedHeight(height);
    if (bounded === null) return null;
    this.clearFallbackTimer();
    this.manualHeight = bounded;
    this.applyLayout(this.layout);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const settings = this.settingsStore?.set?.({
        captionOverlayHeight: this.manualHeight,
      });
      if (settings) {
        this.broadcast(
          'captions:settings',
          this.settingsPayload(settings),
        );
      }
    }, this.persistDelayMs);
    this.persistTimer.unref?.();
    return bounded;
  }

  resetAutoSize() {
    this.clearFallbackTimer();
    this.manualHeight = null;
    this.automaticHeight = null;
    this.contentMeasurements.clear();
    this.autoSizeGeneration += 1;
    const settings =
      this.settingsStore?.set?.({ captionOverlayHeight: null }) || {
        captionOverlayHeight: null,
      };
    this.applyLayout(this.layout);
    return settings;
  }

  applySettings(settings = {}) {
    if (Object.hasOwn(settings, 'layout')) {
      this.layout =
        settings.layout === 'side-by-side' ? 'side-by-side' : 'stacked';
    }
    if (Object.hasOwn(settings, 'captionOverlayHeight')) {
      this.manualHeight = boundedHeight(settings.captionOverlayHeight);
    }
    if (Object.hasOwn(settings, 'captionTheme')) {
      this.captionTheme = themeById(settings.captionTheme).id;
      for (const audience of AUDIENCES) {
        const window = this.captionWindows.get(audience);
        if (window && !window.isDestroyed()) {
          window.setBackgroundColor?.(this.audienceBackground(audience));
        }
      }
    }
    if (Object.hasOwn(settings, 'outputMode')) {
      const outputMode =
        settings.outputMode === 'virtual-camera'
          ? 'virtual-camera'
          : 'overlays';
      const changed = outputMode !== this.outputMode;
      this.outputMode = outputMode;
      if (changed) this.applySelectedOutput();
    }
    this.applyLayout(this.layout);
  }

  settingsPayload(settings) {
    return {
      ...settings,
      captionAutoSizeGeneration: this.autoSizeGeneration,
    };
  }

  broadcastControl(channel, payload) {
    if (this.controlWindow && !this.controlWindow.isDestroyed()) {
      this.controlWindow.webContents.send(channel, payload);
    }
  }

  broadcast(channel, payload) {
    this.broadcastControl(channel, payload);
    for (const window of this.captionWindows.values()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
    if (this.cameraStageWindow && !this.cameraStageWindow.isDestroyed()) {
      this.cameraStageWindow.webContents.send(channel, payload);
    }
    if (this.cameraOutputWindow && !this.cameraOutputWindow.isDestroyed()) {
      this.cameraOutputWindow.webContents.send(channel, payload);
    }
  }
}

module.exports = { CaptionWindowManager, boundedHeight, themeById };
