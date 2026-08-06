const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = new Set([
  'captions:event',
  'captions:audience-event',
  'captions:status',
  'captions:metrics',
  'captions:evaluation',
  'captions:layout',
  'captions:settings',
  'captions:backup-state',
  'captions:pending-meeting-records',
  'captions:preview-visibility',
  'captions:native-camera-health',
]);

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

function subscribe(channel, callback) {
  if (!EVENT_CHANNELS.has(channel) || typeof callback !== 'function') {
    throw new Error('Unsupported caption event subscription');
  }
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('captions', {
  // The main process already branches on platform to choose the window's title-bar
  // style, so the renderer must not sniff the user agent to reach the same
  // conclusion and risk disagreeing with it. It needs this only to know how much
  // room the OS chrome takes above the content.
  platform: process.platform,
  credentialStatus: () => invoke('captions:credential-status'),
  setCredential: (value) => invoke('captions:credential-set', { value }),
  deleteCredential: () => invoke('captions:credential-delete'),
  repairCredential: () => invoke('captions:credential-repair'),
  validateCredential: (value) =>
    invoke('captions:credential-validate', { value }),
  requestMicrophoneAccess: () =>
    invoke('captions:microphone-request'),
  getSettings: () => invoke('captions:settings-get'),
  getGlossaryConfigurations: () =>
    invoke('captions:glossary-configurations'),
  importGlossary: () => invoke('captions:glossary-import'),
  exportGlossary: () => invoke('captions:glossary-export'),
  setSettings: (patch) => invoke('captions:settings-set', patch),
  chooseMeetingRecordsDirectory: () =>
    invoke('captions:meeting-records-directory-choose'),
  openMeetingRecordsFolder: () => invoke('captions:meeting-records-open'),
  listPendingMeetingRecords: () =>
    invoke('captions:meeting-records-pending'),
  keepMeetingAudio: (sessionId) =>
    invoke('captions:meeting-record-keep', { sessionId }),
  discardMeetingAudio: (sessionId) =>
    invoke('captions:meeting-record-discard', { sessionId }),
  revealMeetingRecord: (sessionId) =>
    invoke('captions:meeting-record-reveal', { sessionId }),
  exportMeetingRecord: (sessionId) =>
    invoke('captions:meeting-record-export', { sessionId }),
  startSession: (request) => invoke('captions:session-start', request),
  stopSession: () => invoke('captions:session-stop'),
  getSessionStatus: () => invoke('captions:session-status'),
  rateEvaluation: (rating) => invoke('captions:evaluation-rate', rating),
  setScreeningPrompt: (prompt) =>
    invoke('captions:screening-prompt-set', prompt),
  abortShadow: () => invoke('captions:shadow-abort'),
  listRecordings: () => invoke('captions:recordings-list'),
  showWindows: () => invoke('captions:windows-show'),
  hideWindows: () => invoke('captions:windows-hide'),
  showCameraStage: () => invoke('captions:camera-stage-show'),
  hideCameraStage: () => invoke('captions:camera-stage-hide'),
  getPreviewVisibility: () => invoke('captions:preview-visibility-get'),
  getCameraStageSnapshot: () => invoke('captions:camera-stage-snapshot'),
  getNativeCameraHealth: () => invoke('captions:native-camera-health-get'),
  installNativeCamera: () => invoke('captions:native-camera-install'),
  repairNativeCamera: () => invoke('captions:native-camera-repair'),
  removeNativeCamera: () => invoke('captions:native-camera-remove'),
  retryNativeCamera: () => invoke('captions:native-camera-retry'),
  setLayout: (layout) => invoke('captions:layout-set', { layout }),
  reportCaptionContentHeight: (audience, height, generation) =>
    invoke('captions:overlay-content-height', { audience, height, generation }),
  exportSession: (format) => invoke('captions:export', { format }),
  openPrivacy: () => invoke('captions:open-privacy'),
  sendAudio: (channel, samples) => {
    if (!['microphone', 'system'].includes(channel)) return;
    const typed =
      samples instanceof Int16Array ? samples : new Int16Array(samples);
    ipcRenderer.send('captions:audio', {
      channel,
      samples: typed,
      capturedAt: performance.timeOrigin + performance.now(),
    });
  },
  supportsSystemAudio: () => invoke('supports-system-audio-capture'),
  listSystemAudioSources: () => invoke('list-system-audio-sources'),
  connectSystemAudioSource: (sourceId) =>
    invoke('connect-system-audio-source', sourceId),
  disconnectSystemAudioSource: () =>
    invoke('disconnect-system-audio-source'),
  checkScreenRecordingPermission: () =>
    invoke('check-screen-recording-permission'),
  enableLoopbackAudio: () => invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => invoke('disable-loopback-audio'),
  fixMonitorVolume: () => invoke('fix-monitor-volume'),
  onCaption: (callback) => subscribe('captions:event', callback),
  onAudienceCaption: (callback) =>
    subscribe('captions:audience-event', callback),
  onStatus: (callback) => subscribe('captions:status', callback),
  onMetrics: (callback) => subscribe('captions:metrics', callback),
  onEvaluation: (callback) => subscribe('captions:evaluation', callback),
  onLayout: (callback) => subscribe('captions:layout', callback),
  onSettings: (callback) => subscribe('captions:settings', callback),
  onBackupState: (callback) => subscribe('captions:backup-state', callback),
  onPendingMeetingRecords: (callback) =>
    subscribe('captions:pending-meeting-records', callback),
  onPreviewVisibility: (callback) =>
    subscribe('captions:preview-visibility', callback),
  onNativeCameraHealth: (callback) =>
    subscribe('captions:native-camera-health', callback),
});

// Compatibility bridge for Sokuji's retained audio capture classes. It is
// intentionally limited to capture-only operations and does not expose the
// generic IPC surface used by the original application.
const AUDIO_INVOKE_CHANNELS = new Set([
  'supports-system-audio-capture',
  'list-system-audio-sources',
  'connect-system-audio-source',
  'disconnect-system-audio-source',
  'check-screen-recording-permission',
  'enable-loopback-audio',
  'disable-loopback-audio',
  'fix-monitor-volume',
]);
contextBridge.exposeInMainWorld('electron', {
  invoke: (channel, payload) => {
    if (!AUDIO_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error('Unsupported audio operation'));
    }
    return invoke(channel, payload);
  },
});
