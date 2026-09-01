const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
} = require('electron');
const path = require('path');
const { initMain } = require('electron-audio-loopback');
const { appIconPath } = require('./captions/app-icon');
const { CaptionSessionManager } = require('./captions/caption-session-manager');
const { CaptionWindowManager } = require('./captions/caption-window-manager');
const { CameraRegionPublisher } = require('./captions/camera-region-publisher');
const {
  CameraStageFramePublisher,
} = require('./captions/camera-stage-frame-publisher');
const { CredentialStore } = require('./captions/credential-store');
const { EvaluationRecorder } = require('./captions/evaluation-recorder');
const { createLocalInferenceRuntime } = require('./captions/local-inference-runtime');
const {
  MeetingRecordController,
} = require('./captions/meeting-record-controller');
const { registerCaptionIpc } = require('./captions/register-caption-ipc');
const {
  NativeCameraInstaller,
  runSquirrelNativeCameraCleanup,
} = require('./captions/native-camera-installer');
const {
  NativeCameraSupervisor,
  nativeCameraSupport,
} = require('./captions/native-camera-supervisor');
const { SettingsStore } = require('./captions/settings-store');
const {
  registerControlWindowLifecycle,
} = require('./captions/app-lifecycle');
const {
  applyAppUserModelId,
  handleSquirrelStartup,
} = require('./captions/squirrel-startup');

// Squirrel install/update/uninstall launches must create shortcuts and exit
// before anything else initializes, or installation flashes a duplicate control
// window and leaves a stray process running.
const consumedBySquirrel = handleSquirrelStartup({
  quit: () => app.quit(),
  cleanupNativeCamera: () => runSquirrelNativeCameraCleanup(),
});

process.on('uncaughtException', (error) => {
  console.error('[Twinscript] Fatal main-process error:', error);
  app.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('[Twinscript] Unhandled main-process rejection:', error);
});

if (!consumedBySquirrel) initMain();

app.setName('Twinscript');
applyAppUserModelId({ app });
app.commandLine.appendSwitch('application-name', 'twinscript');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let controlWindow = null;
let captionWindows = null;
let sessionManager = null;
let meetingRecordController = null;
let nativeCameraSupervisor = null;
let localInferenceSupervisor = null;
let localModelService = null;
let shutdownPromise = null;
let shutdownComplete = false;

function isDevelopment() {
  return import.meta.env.MODE === 'development' || !app.isPackaged;
}

function allowedLocalUrl(url) {
  return isDevelopment()
    ? url.startsWith('http://127.0.0.1:5173') ||
        url.startsWith('http://localhost:5173')
    : url.startsWith('file://');
}

function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://developers.openai.com/')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowedLocalUrl(url)) event.preventDefault();
  });
}

function loadControlWindow(window) {
  if (isDevelopment()) {
    void window.loadURL('http://localhost:5173/?surface=control');
  } else {
    void window.loadFile(path.join(app.getAppPath(), 'build/index.html'), {
      query: { surface: 'control' },
    });
  }
}

function createControlWindow() {
  const controlWindowIcon = appIconPath({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
  });
  controlWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    title: 'Twinscript',
    // Without this the window inherited Electron's own default icon in
    // development and on Linux: the shipped caption entry point never set one,
    // while the retired Sokuji entry point (electron/main.js) did. Omitted rather
    // than passed empty when the file cannot be found, so Electron's fallback is a
    // deliberate outcome instead of a bad path silently producing the same thing.
    ...(controlWindowIcon ? { icon: controlWindowIcon } : {}),
    backgroundColor: '#F3F4F6',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // On Windows and Linux the application menu is drawn INSIDE the window, so
    // File/Edit/View/Help cost a permanent row of the operator's screen. Nothing in
    // it is reachable only from there - Show/Hide Caption Windows duplicates the
    // Preview button, and the Help link now sits in the footer - so it is hidden
    // rather than removed: Alt still reveals it, and every accelerator keeps working,
    // which deleting the menu would break. On macOS the menu lives in the system bar
    // and costs no window space, and removing its Edit roles would break Cmd+C/V.
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'captions-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  hardenWindow(controlWindow);
  loadControlWindow(controlWindow);
  controlWindow.once('ready-to-show', () => controlWindow?.show());
  registerControlWindowLifecycle({
    app,
    controlWindow,
    onClosed: () => {
      controlWindow = null;
    },
  });
  return controlWindow;
}

function createMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'Show Caption Windows',
            accelerator: 'CmdOrCtrl+Shift+C',
            click: () => captionWindows?.showAll(),
          },
          {
            label: 'Hide Caption Windows',
            accelerator: 'CmdOrCtrl+Shift+H',
            click: () => captionWindows?.hideAll(),
          },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          ...(isDevelopment() ? [{ role: 'toggleDevTools' }] : []),
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
      {
        role: 'help',
        submenu: [
          {
            label: 'OpenAI data controls',
            click: () =>
              shell.openExternal(
                'https://developers.openai.com/api/docs/guides/your-data',
              ),
          },
        ],
      },
    ]),
  );
}

function installSecurityPolicies() {
  const currentSession = session.defaultSession;
  currentSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const trusted =
        webContents &&
        [
          controlWindow,
          ...(captionWindows?.captionWindows.values() || []),
          captionWindows?.cameraStageWindow,
          captionWindows?.cameraOutputWindow,
        ].some(
          (window) =>
            window &&
            !window.isDestroyed() &&
            window.webContents.id === webContents.id,
        );
      callback(
        Boolean(trusted) &&
          ['media', 'display-capture', 'fullscreen'].includes(permission),
      );
    },
  );
  currentSession.setPermissionCheckHandler(
    (webContents, permission) => {
      const trusted =
        webContents &&
        [
          controlWindow,
          ...(captionWindows?.captionWindows.values() || []),
          captionWindows?.cameraStageWindow,
          captionWindows?.cameraOutputWindow,
        ].some(
          (window) =>
            window &&
            !window.isDestroyed() &&
            window.webContents.id === webContents.id,
        );
      return (
        Boolean(trusted) &&
        ['media', 'display-capture', 'fullscreen'].includes(permission)
      );
    },
  );
  currentSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          isDevelopment()
            ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:5173 ws://127.0.0.1:5173; media-src 'self' blob:; worker-src 'self' blob:;"
            : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:;",
        ],
      },
    });
  });
}

function platformAudioUtils() {
  if (process.platform === 'darwin') return require('./macos-audio-utils');
  if (process.platform === 'win32') return require('./windows-audio-utils');
  if (process.platform === 'linux') return require('./pulseaudio-utils');
  return {};
}

function registerAudioCaptureIpc() {
  const audio = platformAudioUtils();
  ipcMain.handle('supports-system-audio-capture', async () =>
    audio.supportsSystemAudioCapture
      ? audio.supportsSystemAudioCapture()
      : false,
  );
  ipcMain.handle('list-system-audio-sources', async () =>
    audio.listSystemAudioSources ? audio.listSystemAudioSources() : [],
  );
  ipcMain.handle('connect-system-audio-source', async (_event, sinkName) =>
    audio.connectSystemAudioSource
      ? audio.connectSystemAudioSource(sinkName)
      : { success: true },
  );
  ipcMain.handle('disconnect-system-audio-source', async () =>
    audio.disconnectSystemAudioSource
      ? audio.disconnectSystemAudioSource()
      : { success: true },
  );
  ipcMain.handle('fix-monitor-volume', async () =>
    audio.fixMonitorVolume ? audio.fixMonitorVolume() : { ok: true },
  );
  ipcMain.handle('check-screen-recording-permission', async () => {
    if (process.platform !== 'darwin') {
      return { status: 'granted', platform: process.platform };
    }
    return {
      status: systemPreferences.getMediaAccessStatus('screen'),
      platform: 'darwin',
    };
  });
}

app.whenReady().then(async () => {
  // A Squirrel lifecycle launch is already quitting; `whenReady` can still
  // resolve first, and creating windows here is what produces the duplicate
  // window during installation.
  if (consumedBySquirrel) return;
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular');
    await app.dock.show();
  }
  createControlWindow();
  const settingsStore = new SettingsStore(app);
  const nativeSupport = nativeCameraSupport();
  const nativeCameraInstaller = new NativeCameraInstaller({
    support: nativeSupport,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  nativeCameraSupervisor = new NativeCameraSupervisor({
    expectedHostPath: path.win32.join(
      nativeCameraInstaller.sourceDirectory,
      'vcam-host.exe',
    ),
    expectedSourcePath: path.win32.join(
      nativeCameraInstaller.sourceDirectory,
      'twinscript-vcam-source.dll',
    ),
    onHealth: (health) =>
      captionWindows?.broadcastControl(
        'captions:native-camera-health',
        health,
      ),
  });
  const cameraFramePublisher = nativeSupport.supported
    ? new CameraStageFramePublisher({
        regionPublisher: new CameraRegionPublisher(),
        onError: (error) =>
          nativeCameraSupervisor?.reportPublisherFailure(error),
      })
    : null;
  captionWindows = new CaptionWindowManager({
    app,
    BrowserWindow,
    screen,
    controlWindow,
    isDev: isDevelopment(),
    preloadPath: path.join(__dirname, 'captions-preload.js'),
    iconPath: appIconPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
    }),
    settingsStore,
    cameraFramePublisher,
    nativeCameraSupervisor,
  });
  captionWindows.createAll();
  installSecurityPolicies();
  createMenu();

  const credentialStore = new CredentialStore({ app, safeStorage });
  const evaluationRecorder = new EvaluationRecorder({ app, safeStorage });
  const localInferenceRuntime = createLocalInferenceRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    userDataPath: app.getPath('userData'),
    cudaEnabled:
      process.platform === 'win32' && process.env.TWINSCRIPT_HYMT2_CUDA === '1',
  });
  localInferenceSupervisor = localInferenceRuntime.supervisor;
  localModelService = localInferenceRuntime.service;
  meetingRecordController = new MeetingRecordController({
    app,
    safeStorage,
    settingsStore,
  });
  meetingRecordController.onBackupState = (backupState) => {
    captionWindows.broadcastControl('captions:backup-state', backupState);
  };
  const pendingMeetingRecords =
    await meetingRecordController.recoverPendingSessions({
      appVersion: app.getVersion(),
    });
  sessionManager = new CaptionSessionManager({
    credentialStore,
    settingsStore,
    onCaption: (event) => captionWindows.publishCaption(event),
    onStatus: (status) => captionWindows.publishStatus(status),
    onMetrics: (metrics) => captionWindows.broadcast('captions:metrics', metrics),
    onEvaluation: (result) =>
      captionWindows.broadcastControl('captions:evaluation', result),
    evaluationRecorder,
    meetingRecordController,
    localInferenceSupervisor,
    admissionGate: localInferenceRuntime.admissionGate,
    appVersion: app.getVersion(),
  });
  localInferenceRuntime.attachSessionManager(sessionManager);
  const requestMicrophoneAccess = async () => {
    if (process.platform !== 'darwin') {
      return { granted: true, status: 'granted' };
    }
    const current = systemPreferences.getMediaAccessStatus('microphone');
    const granted =
      current === 'granted'
        ? true
        : await systemPreferences.askForMediaAccess('microphone');
    return {
      granted,
      status: systemPreferences.getMediaAccessStatus('microphone'),
    };
  };
  registerAudioCaptureIpc();
  registerCaptionIpc({
    ipcMain,
    app,
    dialog,
    shell,
    windows: captionWindows,
    sessionManager,
    settingsStore,
    credentialStore,
    evaluationRecorder,
    meetingRecordController,
    requestMicrophoneAccess,
    nativeCameraSupervisor,
    nativeCameraInstaller,
    localInferenceSupervisor,
    localModelService,
  });
  captionWindows.broadcastControl(
    'captions:pending-meeting-records',
    pendingMeetingRecords,
  );
  const settings = settingsStore.get();
  captionWindows.applySettings(settings);
});

app.on('activate', () => {
  if (consumedBySquirrel) return;
  if (!controlWindow) {
    createControlWindow();
    if (captionWindows) captionWindows.controlWindow = controlWindow;
  } else {
    controlWindow.show();
    controlWindow.focus();
  }
});

app.on('before-quit', (event) => {
  app.isQuitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;
  shutdownPromise = (async () => {
    await captionWindows?.stopCameraOutput();
    await sessionManager?.stop();
    await localInferenceSupervisor?.dispose();
    meetingRecordController?.destroy();
  })()
    .catch((error) => {
      console.error('[Twinscript] Shutdown failed:', error);
    })
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
