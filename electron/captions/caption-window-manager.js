const path = require('path');
const CAPTION_THEMES = require('../../shared/caption-themes.json');
const { projectForAudience } = require('./caption-domain');
const { computeOverlayBounds } = require('./overlay-layout');
const { loadDevRendererUrl } = require('./dev-renderer-load');
const {
  anchoredBounds,
  initialBounds: initialHudBounds,
  pointerWithin,
  resolveDockEdge,
} = require('./session-hud-dock');

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
    // Injected rather than resolved here, the same way preloadPath is: this module
    // is constructed with fakes in the main-process tests, and reaching for the
    // real filesystem to find an icon would make every one of them depend on the
    // repo layout.
    iconPath = '',
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
    this.iconPath = iconPath;
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
    this.sessionHudWindow = null;
    this.sessionHudEdge = null;
    this.sessionHudExpanded = false;
    this.sessionHudMoveTimer = null;
    this.sessionHudHoverTimer = null;
    this.sessionHudCollapseAt = 0;
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

  /**
   * The work area the overlays should be laid out within.
   *
   * Anchored to the display the overlays are ALREADY on, not the one the mouse
   * happens to be over. Using the cursor's display meant that after dragging an
   * overlay to a second monitor, any later reapply — a layout change, a height
   * change, or the frequently-fired `display-metrics-changed` — recomputed bounds
   * for wherever the pointer was and yanked the window back to the original
   * screen. The cursor is only a sensible guess for the very first placement,
   * before any window exists to ask.
   */
  targetWorkArea() {
    const anchor = this.anchorDisplay();
    return anchor?.workArea || { x: 0, y: 0, width: 1280, height: 720 };
  }

  anchorDisplay() {
    // Prefer a live caption window's own centre: that is the display the operator
    // put it on.
    for (const audience of AUDIENCES) {
      const window = this.captionWindows.get(audience);
      if (!window || window.isDestroyed?.()) continue;
      const bounds = window.getBounds?.();
      if (!bounds || !bounds.width || !bounds.height) continue;
      const centre = {
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2),
      };
      const display = this.screen.getDisplayNearestPoint(centre);
      if (display) return display;
    }
    // No window yet: fall back to the cursor for initial placement only.
    return this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint());
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

  /**
   * Opening size for the *visible* preview.
   *
   * The offscreen output window stays exactly 1920x1080 because that is the
   * frame contract, but the preview is only something the operator looks at.
   * Opening it at 1920x1080 covered three quarters of a 2560-wide desktop and
   * felt like the app had taken over the screen. Fit it inside the work area
   * instead; the aspect ratio stays locked and OBS users can drag it larger.
   */
  previewStageSize() {
    const area = this.targetWorkArea();
    const maxWidth = Math.floor(area.width * 0.6);
    const maxHeight = Math.floor(area.height * 0.6);
    let width = Math.min(1920, Math.max(640, maxWidth));
    let height = Math.round((width * 9) / 16);
    if (height > maxHeight) {
      height = Math.max(360, maxHeight);
      width = Math.round((height * 16) / 9);
    }
    return { width, height };
  }

  createCameraStageWindow() {
    if (
      this.cameraStageWindow &&
      !this.cameraStageWindow.isDestroyed()
    ) {
      return this.cameraStageWindow;
    }
    const preview = this.previewStageSize();
    const window = new this.BrowserWindow({
      width: preview.width,
      height: preview.height,
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
      title: 'Twinscript Camera Stage',
      // The one caption window that appears in the taskbar, so it is the one that
      // needs the mark. The overlays set skipTaskbar and are frameless, so an icon
      // on them would never be drawn.
      ...(this.iconPath ? { icon: this.iconPath } : {}),
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
      window.setTitle('Twinscript Camera Stage');
    });
    // `role=preview` is what lets the renderer show operator chrome. The
    // offscreen output window loads `role=output` and must never render it.
    this.loadSurface(window, 'camera-stage&role=preview');
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
      title: 'Twinscript Camera Output',
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
    this.loadSurface(window, 'camera-stage&role=output');
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

      // Frame publishing is NEVER gated on the Media Foundation supervisor.
      //
      // The camera is a DirectShow filter now. It is loaded directly into the
      // consumer process and reads the shared region itself, so there is no
      // companion process for anything to supervise. This code used to return
      // early when the MF camera was not installed, and tear publishing down when
      // the MF host failed - which starved the working DirectShow camera of frames
      // and showed a neutral slate in every meeting client. The filter was fine;
      // nothing was writing to the region.
      //
      // The supervisor is now advisory only: its health is still reported so the
      // control panel can show it, but it can neither prevent publishing nor stop
      // it, and its host process is not started - starting it would register a
      // second, non-functional camera with a nearly identical name.
      // Health is reported FIRST and unconditionally, before any early return can
      // skip it. The control panel only subscribes to health, so a state it never
      // receives leaves it rendering the "no supported camera" fallback and hiding
      // the install actions entirely - which is how the camera panel came to have
      // nowhere to repair from.
      if (this.nativeCameraSupervisor) {
        const health = await this.nativeCameraSupervisor.refresh().catch(() => null);
        if (health) this.broadcastControl('captions:native-camera-health', health);
      }

      await this.cameraFramePublisher.start(window);
      if (generation !== this.cameraOutputGeneration) {
        await this.cameraFramePublisher.stop();
        return;
      }
    }).catch(async (error) => {
      this.cameraOutputStarted = false;
      await this.cameraFramePublisher.stop().catch(() => {});
      await this.nativeCameraSupervisor?.stop().catch(() => {});
      this.destroyCameraOutputWindow();
      this.reportCameraOutputFailure(error);
    });
    this.cameraOutputLifecycle = startPromise;
    return null;
  }

  /**
   * Report a camera output failure without flattening the health report.
   *
   * Routed through the supervisor so the patch MERGES onto what it already
   * knows - `supported`, `installed`, `reason`. Both call sites used to
   * broadcast `{ state, message }` straight to the control window, and the
   * renderer replaces its health report rather than merging it, so `supported`
   * became `undefined`. A Windows machine with the filter correctly registered
   * was then told it could not host a virtual camera at all and pointed at OBS,
   * and the real error never reached the screen because the not-supported
   * branch returned before the message could be read.
   */
  reportCameraOutputFailure(error) {
    if (this.nativeCameraSupervisor) {
      this.nativeCameraSupervisor.reportPublisherFailure(error);
      return;
    }
    // No supervisor means the platform has no camera to host, so a complete
    // not-supported report is the honest thing to send - and it is complete,
    // which is the point.
    this.broadcastControl('captions:native-camera-health', {
      state: 'failed',
      supported: false,
      installed: false,
      reason: 'windows-only',
      restartCount: 0,
      message: error instanceof Error ? error.message : String(error),
      code: 'camera-output-failed',
    });
  }

  stopCameraOutput() {
    this.cameraOutputGeneration += 1;
    this.cameraOutputStarted = false;
    const stopPromise = this.cameraOutputLifecycle.catch(() => {}).then(async () => {
      await this.cameraFramePublisher?.stop();
      await this.nativeCameraSupervisor?.stop();
    }).catch((error) => {
      this.reportCameraOutputFailure(error);
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
    // Recorded so tests can assert that every camera window declares its role;
    // the offscreen output must never load the chrome-bearing preview surface.
    (this.loadedSurfaces ||= []).push(query);
    if (this.isDev) {
      // Same race as the control window: these lost it too, which is why an
      // opened camera stage showed nothing but its background colour.
      loadDevRendererUrl({
        window,
        url: `http://localhost:5173/?surface=${query}`,
      });
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

  /**
   * A manually dragged height is **authoritative**.
   *
   * This previously returned `Math.max(manualHeight, automaticHeight)`, treating a
   * dragged height as a floor so that growing content could still expand the
   * window. That made the overlay feel broken in the most direct way possible: an
   * operator dragging the window smaller than the current content measurement saw
   * it snap straight back, every time, with no way to win.
   *
   * The reason the floor existed — that raising visible history would otherwise
   * clip the extra lines — is now solved in the right place. The surface scales its
   * own font to fit the height it has, so content adapts to the window instead of
   * the window fighting the operator. Height is the operator's decision; fitting
   * content into it is ours.
   */
  effectiveHeight() {
    if (this.manualHeight !== null && this.manualHeight !== undefined) {
      return this.manualHeight;
    }
    return this.automaticHeight ?? null;
  }

  requestedHeight() {
    return this.effectiveHeight() ?? undefined;
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
    // The HUD follows the session, not the window layout: it exists only
    // while there is something to stop.
    if (['starting', 'running', 'connected'].includes(status.state)) {
      this.showSessionHud();
    } else if (
      ['stopped', 'ready', 'budget-exhausted', 'failed'].includes(status.state)
    ) {
      this.hideSessionHud();
    }
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
    // Measurements are applied even when a manual height exists, because that
    // height is only a floor. Both overlays share one height so the stacked and
    // side-by-side pairs stay symmetric.
    if (this.contentMeasurements.size === 0) return;
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
    this.automaticHeight = null;
    this.contentMeasurements.clear();
    this.autoSizeGeneration += 1;
    this.applyLayout(this.layout);
    const currentSettings = this.settingsStore?.get?.() || {};
    this.broadcast(
      'captions:settings',
      this.settingsPayload({
        ...currentSettings,
        captionOverlayHeight: this.manualHeight,
      }),
    );
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

  /**
   * Invalidate the current content measurements and ask for fresh ones.
   *
   * Called when visible history changes, where the natural content height is
   * now different. It deliberately keeps `manualHeight`: clearing it discarded
   * the size the operator had dragged to, so adjusting history silently threw
   * away their layout. Only the measured component resets.
   */
  resetContentMeasurements() {
    this.clearFallbackTimer();
    this.automaticHeight = null;
    this.contentMeasurements.clear();
    this.autoSizeGeneration += 1;
    this.applyLayout(this.layout);
    return (
      this.settingsStore?.get?.() || {
        captionOverlayHeight: this.manualHeight,
      }
    );
  }

  /** Also drop the manual floor, returning the overlays to pure auto-sizing. */
  resetAutoSize() {
    this.manualHeight = null;
    const settings = this.resetContentMeasurements();
    const persisted = this.settingsStore?.set?.({ captionOverlayHeight: null });
    return persisted || { ...settings, captionOverlayHeight: null };
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

  /**
   * The floating session HUD.
   *
   * A running session could become impossible to stop. The overlays and the
   * camera stage are always-on-top, so they can cover the control window
   * completely, and Stop existed only inside it - leaving no way to end a session
   * except closing the caption windows first. This pill carries the session state
   * and its own Stop, above everything, so stopping never depends on finding the
   * main window again.
   *
   * Sized to its content rather than being a large transparent surface: a
   * transparent frameless window still swallows clicks over its see-through area,
   * which would block whatever sits underneath it.
   */
  createSessionHudWindow() {
    if (this.sessionHudWindow && !this.sessionHudWindow.isDestroyed()) {
      return this.sessionHudWindow;
    }
    const workArea = this.targetWorkArea();
    const bounds = initialHudBounds({ workArea });
    const window = new this.BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      title: 'Twinscript session',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    // Above the caption overlays, which are themselves screen-saver level. The
    // HUD is the escape hatch from those windows, so it has to outrank them.
    window.setAlwaysOnTop(true, 'screen-saver', 2);
    if (process.platform === 'darwin') {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    this.hardenWindow(window);
    this.loadSurface(window, 'session-hud');
    window.on('close', (event) => {
      if (!this.app.isQuitting) {
        event.preventDefault();
        window.hide();
      }
    });
    // Dock on release. `moved` fires continuously during an app-region drag, so
    // the snap is debounced to the end of the gesture - snapping mid-drag would
    // fight the pointer.
    window.on('moved', () => {
      if (this.sessionHudMoveTimer) clearTimeout(this.sessionHudMoveTimer);
      this.sessionHudMoveTimer = setTimeout(() => {
        this.sessionHudMoveTimer = null;
        this.settleSessionHud();
      }, 220);
    });
    this.sessionHudWindow = window;
    return window;
  }

  /** Decide whether the HUD's resting place is an edge, and move it there. */
  settleSessionHud() {
    const window = this.sessionHudWindow;
    if (!window || window.isDestroyed()) return;
    const workArea = this.targetWorkArea();
    const current = window.getBounds();
    // The edge it is already on is passed in, so an attached pill needs a
    // deliberate drag to let go rather than snapping back from a nudge.
    this.sessionHudEdge = resolveDockEdge({
      bounds: current,
      workArea,
      currentEdge: this.sessionHudEdge,
    });
    window.setBounds(
      anchoredBounds({
        edge: this.sessionHudEdge,
        bounds: current,
        workArea,
        expanded: this.sessionHudExpanded,
      }),
    );
    window.webContents.send('captions:session-hud-dock', {
      edge: this.sessionHudEdge,
    });
  }

  /**
   * Grow to reveal Stop, or shrink back to status only.
   *
   * Driven by the renderer's pointer, because a docked pill is mostly off screen
   * and the only reliable "the operator is reaching for this" signal is the
   * pointer entering the part still visible.
   */
  setSessionHudExpanded(expanded) {
    const window = this.sessionHudWindow;
    this.sessionHudExpanded = Boolean(expanded);
    if (!window || window.isDestroyed()) {
      return { expanded: this.sessionHudExpanded };
    }
    window.setBounds(
      anchoredBounds({
        edge: this.sessionHudEdge,
        bounds: window.getBounds(),
        workArea: this.targetWorkArea(),
        expanded: this.sessionHudExpanded,
      }),
    );
    return { expanded: this.sessionHudExpanded };
  }

  /**
   * Reveal on hover, decided from the cursor rather than from pointer events.
   *
   * The renderer cannot do this. On Windows a `-webkit-app-region: drag` region
   * is implemented as non-client hit-testing, so no mouse events reach the page
   * over it - and the whole pill is draggable, which is why hovering it revealed
   * nothing at all. Clicks on Stop still arrive because that opts out with
   * `no-drag`; hover was the part that was lost.
   *
   * Polled at 120ms: fast enough that the reveal feels immediate, slow enough to
   * be free. Expansion is instant and collapse waits, so the window resizing
   * under the cursor cannot start an expand/collapse oscillation - the same
   * hysteresis the renderer applies, kept here because this is now the authority.
   */
  watchSessionHudHover({ intervalMs = 120, collapseDelayMs = 420 } = {}) {
    if (this.sessionHudHoverTimer) return;
    this.sessionHudHoverTimer = setInterval(() => {
      const window = this.sessionHudWindow;
      if (!window || window.isDestroyed() || !window.isVisible()) return;
      let point = null;
      try {
        point = this.screen.getCursorScreenPoint();
      } catch {
        return;
      }
      const inside = pointerWithin(window.getBounds(), point);
      if (inside) {
        this.sessionHudCollapseAt = 0;
        if (!this.sessionHudExpanded) this.applySessionHudHover(true);
        return;
      }
      if (!this.sessionHudExpanded) return;
      const now = Date.now();
      if (!this.sessionHudCollapseAt) {
        this.sessionHudCollapseAt = now + collapseDelayMs;
        return;
      }
      if (now >= this.sessionHudCollapseAt) {
        this.sessionHudCollapseAt = 0;
        this.applySessionHudHover(false);
      }
    }, intervalMs);
    // Never hold the process open for a hover poll.
    this.sessionHudHoverTimer.unref?.();
  }

  stopWatchingSessionHudHover() {
    if (!this.sessionHudHoverTimer) return;
    clearInterval(this.sessionHudHoverTimer);
    this.sessionHudHoverTimer = null;
    this.sessionHudCollapseAt = 0;
  }

  /** Resize for the new state and tell the pill what to draw. */
  applySessionHudHover(expanded) {
    this.setSessionHudExpanded(expanded);
    const window = this.sessionHudWindow;
    if (!window || window.isDestroyed()) return;
    window.webContents.send('captions:session-hud-hover', { expanded: Boolean(expanded) });
  }

  showSessionHud() {
    const window = this.createSessionHudWindow();
    if (window.isDestroyed()) return;
    // showInactive: appearing must not steal focus from the meeting client.
    if (!window.isVisible()) window.showInactive();
    this.watchSessionHudHover();
  }

  hideSessionHud() {
    const window = this.sessionHudWindow;
    this.stopWatchingSessionHudHover();
    if (!window || window.isDestroyed()) return;
    if (this.sessionHudMoveTimer) {
      clearTimeout(this.sessionHudMoveTimer);
      this.sessionHudMoveTimer = null;
    }
    // Collapsed on the way out, and actually resized - not just flagged. Setting
    // the flag alone left the window at its expanded size, so the next session
    // opened as a wide pill with no Stop in it until the cursor happened to pass
    // over. Caught by session-hud-hover.test.cjs.
    this.setSessionHudExpanded(false);
    window.hide();
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
    if (this.sessionHudWindow && !this.sessionHudWindow.isDestroyed()) {
      this.sessionHudWindow.webContents.send(channel, payload);
    }
  }
}

module.exports = { CaptionWindowManager, boundedHeight, themeById };
