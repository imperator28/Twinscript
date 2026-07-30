const path = require('path');
const { projectForAudience } = require('./caption-domain');
const {
  CaptionPresentationPacer,
  DEFAULT_PACE_MS,
} = require('./caption-presentation-pacer');

class CaptionWindowManager {
  constructor({ app, BrowserWindow, screen, controlWindow, isDev, preloadPath }) {
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.screen = screen;
    this.controlWindow = controlWindow;
    this.isDev = isDev;
    this.preloadPath = preloadPath;
    this.captionWindows = new Map();
    this.layout = 'stacked';
    this.presentationPacer = new CaptionPresentationPacer({
      paceMs: DEFAULT_PACE_MS,
      onPresent: (event) => this.presentCaption(event),
    });
  }

  createAll() {
    for (const audience of ['en', 'zh']) this.createCaptionWindow(audience);
    this.applyLayout(this.layout);
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
      backgroundColor: audience === 'en' ? '#10233F' : '#4A171E',
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
    window.on('close', (event) => {
      if (!this.app.isQuitting) {
        event.preventDefault();
        window.hide();
      }
    });
    this.captionWindows.set(audience, window);
    return window;
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

  showAll() {
    for (const window of this.captionWindows.values()) {
      window.showInactive();
      window.setAlwaysOnTop(true, 'screen-saver', 1);
    }
  }

  hideAll() {
    for (const window of this.captionWindows.values()) window.hide();
  }

  applyLayout(layout = 'stacked') {
    this.layout = layout === 'side-by-side' ? 'side-by-side' : 'stacked';
    const display = this.screen.getDisplayNearestPoint(
      this.screen.getCursorScreenPoint(),
    );
    const area = display.workArea;
    const margin = 28;
    const gap = 10;

    if (this.layout === 'side-by-side' && area.width >= 1180) {
      const width = Math.floor((area.width - margin * 2 - gap) / 2);
      const height = 174;
      this.captionWindows
        .get('en')
        ?.setBounds({
          x: area.x + margin,
          y: area.y + area.height - height - margin,
          width,
          height,
        });
      this.captionWindows
        .get('zh')
        ?.setBounds({
          x: area.x + margin + width + gap,
          y: area.y + area.height - height - margin,
          width,
          height,
        });
    } else {
      this.layout = 'stacked';
      const width = Math.min(1120, area.width - margin * 2);
      const height = 142;
      const x = area.x + Math.floor((area.width - width) / 2);
      const bottom = area.y + area.height - margin;
      this.captionWindows
        .get('zh')
        ?.setBounds({ x, y: bottom - height, width, height });
      this.captionWindows
        .get('en')
        ?.setBounds({ x, y: bottom - height * 2 - gap, width, height });
    }
    this.broadcastControl('captions:layout', { layout: this.layout });
    return { layout: this.layout };
  }

  publishCaption(event) {
    this.broadcastControl('captions:event', event);
    this.presentationPacer.enqueue(event);
  }

  presentCaption(event) {
    for (const audience of ['en', 'zh']) {
      const window = this.captionWindows.get(audience);
      if (window && !window.isDestroyed()) {
        window.webContents.send(
          'captions:audience-event',
          projectForAudience(event, audience),
        );
      }
    }
  }

  setCaptionPaceMs(value) {
    return this.presentationPacer.setPaceMs(value);
  }

  broadcastControl(channel, payload) {
    if (this.controlWindow && !this.controlWindow.isDestroyed()) {
      this.controlWindow.webContents.send(channel, payload);
    }
  }

  broadcast(channel, payload) {
    if (
      channel === 'captions:status' &&
      ['starting', 'stopped', 'budget-exhausted'].includes(payload?.state)
    ) {
      this.presentationPacer.reset();
    }
    this.broadcastControl(channel, payload);
    for (const window of this.captionWindows.values()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  }
}

module.exports = { CaptionWindowManager };
