const fs = require('fs');
const path = require('path');
const {
  createPortableConfiguration,
  listGlossaryConfigurations,
  parseGlossaryContent,
} = require('./glossary-config');

function assertSender(event, windows) {
  const senderId = event.sender.id;
  const allowed = [
    windows.controlWindow,
    ...windows.captionWindows.values(),
    windows.cameraStageWindow,
    windows.cameraOutputWindow,
  ].some((window) => window && !window.isDestroyed() && window.webContents.id === senderId);
  if (!allowed) throw new Error('Untrusted IPC sender');
}

function safeResult(action) {
  return async (...args) => {
    try {
      return { ok: true, data: await action(...args) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error.code || 'operation_failed',
          message: error.message || 'Operation failed',
        },
      };
    }
  };
}

function assertMeetingSessionId(sessionId) {
  if (
    typeof sessionId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)
  ) {
    const error = new Error('Invalid meeting session identifier');
    error.code = 'invalid_session_id';
    throw error;
  }
  return sessionId;
}

function registerCaptionIpc({
  ipcMain,
  app,
  dialog,
  shell,
  windows,
  sessionManager,
  settingsStore,
  credentialStore,
  evaluationRecorder,
  meetingRecordController,
  requestMicrophoneAccess,
  nativeCameraSupervisor = null,
  nativeCameraInstaller = null,
}) {
  const handle = (channel, action) => {
    ipcMain.handle(
      channel,
      safeResult(async (event, payload) => {
        assertSender(event, windows);
        return action(payload, event);
      }),
    );
  };

  handle('captions:credential-status', () => credentialStore.status());
  handle('captions:credential-set', ({ value }) => credentialStore.set(value));
  handle('captions:credential-delete', () => credentialStore.delete());
  handle('captions:credential-repair', async () => {
    const isMac = (credentialStore.platform || process.platform) === 'darwin';
    const confirmation = await dialog.showMessageBox(windows.controlWindow, {
      type: 'warning',
      title: 'Repair secure storage?',
      message: 'Repair secure storage?',
      detail:
        `This removes only the saved OpenAI API key${
          isMac ? ' and resets this app’s macOS Keychain entry' : ''
        }. You will need to enter the API key again. Meeting records and settings are not changed.`,
      buttons: ['Cancel', isMac ? 'Repair & Restart' : 'Repair'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { canceled: true };

    const result = await credentialStore.repair();
    if (result.relaunchRequired) {
      const relaunchTimer = setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 1_000);
      relaunchTimer.unref?.();
    }
    return { canceled: false, ...result };
  });
  handle('captions:credential-validate', ({ value }) =>
    credentialStore.validate(value),
  );
  handle('captions:microphone-request', () => requestMicrophoneAccess());
  handle('captions:settings-get', () =>
    windows.settingsPayload
      ? windows.settingsPayload(settingsStore.get())
      : settingsStore.get(),
  );
  handle('captions:glossary-configurations', () =>
    listGlossaryConfigurations(),
  );
  handle('captions:glossary-import', async () => {
    const result = await dialog.showOpenDialog(windows.controlWindow, {
      title: 'Import meeting glossary',
      properties: ['openFile'],
      filters: [
        {
          name: 'Meeting glossary',
          extensions: ['json', 'csv', 'tsv', 'txt'],
        },
      ],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return { canceled: true };
    }
    const filePath = result.filePaths[0];
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) {
      throw new Error('Glossary files must be smaller than 2 MB');
    }
    const extension = path.extname(filePath).slice(1);
    const parsed = parseGlossaryContent({
      extension,
      text: fs.readFileSync(filePath, 'utf8'),
      fileName: path.basename(filePath, path.extname(filePath)),
    });
    const settings = settingsStore.set({
      customGlossaryConfiguration: parsed.configuration,
    });
    windows.broadcast('captions:settings', settings);
    return {
      canceled: false,
      settings,
      duplicateCount: parsed.duplicateCount,
      rejectedRows: parsed.rejectedRows,
    };
  });
  handle('captions:glossary-export', async () => {
    const configuration = createPortableConfiguration(settingsStore.get());
    const result = await dialog.showSaveDialog(windows.controlWindow, {
      title: 'Export meeting glossary configuration',
      defaultPath: path.join(
        app.getPath('documents'),
        `${configuration.id}.json`,
      ),
      filters: [{ name: 'Meeting glossary JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(
      result.filePath,
      `${JSON.stringify(configuration, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return { canceled: false, filePath: result.filePath };
  });
  handle('captions:settings-set', (patch) => {
    const previous = settingsStore.get();
    let settings = settingsStore.set(patch);
    if (
      Object.hasOwn(patch || {}, 'captionHistoryEntries') &&
      settings.captionHistoryEntries !== previous.captionHistoryEntries &&
      typeof windows.resetContentMeasurements === 'function'
    ) {
      // Changing visible history changes the natural content height, so the
      // measurements are stale — but the operator's dragged height is not, and
      // must survive as the floor.
      settings = windows.resetContentMeasurements();
    } else if (typeof windows.applySettings === 'function') {
      windows.applySettings(settings);
    } else if (patch.layout) {
      windows.applyLayout(patch.layout);
    }
    const payload = windows.settingsPayload
      ? windows.settingsPayload(settings)
      : settings;
    windows.broadcast('captions:settings', payload);
    return payload;
  });
  handle('captions:meeting-records-directory-choose', async () => {
    const result = await dialog.showOpenDialog(windows.controlWindow, {
      title: 'Choose meeting records folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return { canceled: true };
    }
    const directory = path.resolve(result.filePaths[0]);
    const settings = settingsStore.set({ meetingRecordsDirectory: directory });
    windows.broadcast('captions:settings', settings);
    return { canceled: false, directory, settings };
  });
  handle('captions:meeting-records-pending', () =>
    meetingRecordController
      ? meetingRecordController.recoverPendingSessions({
          appVersion: app.getVersion?.(),
        })
      : [],
  );
  handle('captions:meeting-record-keep', ({ sessionId }) =>
    meetingRecordController.keep(assertMeetingSessionId(sessionId)),
  );
  handle('captions:meeting-record-discard', ({ sessionId }) =>
    meetingRecordController.discard(assertMeetingSessionId(sessionId)),
  );

  const meetingSessionDirectory = (sessionId) => {
    const resolved = meetingRecordController.resolvePendingOrTerminal(
      assertMeetingSessionId(sessionId),
    );
    const sessionDir =
      resolved.manifest?.sessionDir ||
      (resolved.terminal?.recording ? resolved.terminal.sessionDir : null);
    if (!sessionDir) {
      const error = new Error('Meeting record was not found');
      error.code = 'meeting_record_not_found';
      throw error;
    }
    return sessionDir;
  };

  handle('captions:meeting-record-reveal', async ({ sessionId }) => {
    const sessionDir = meetingSessionDirectory(sessionId);
    const error = await shell.openPath(sessionDir);
    if (error) throw new Error(error);
    return { sessionId, sessionDir };
  });
  handle('captions:meeting-record-export', async ({ sessionId }) => {
    const sessionDir = meetingSessionDirectory(sessionId);
    const sourcePath = path.join(sessionDir, 'transcript.md');
    if (!fs.existsSync(sourcePath)) {
      const error = new Error('The readable meeting transcript is unavailable');
      error.code = 'meeting_transcript_unavailable';
      throw error;
    }
    const result = await dialog.showSaveDialog(windows.controlWindow, {
      title: 'Save a copy of the meeting transcript',
      defaultPath: path.join(
        app.getPath('documents'),
        `${path.basename(sessionDir)} transcript.md`,
      ),
      filters: [{ name: 'Markdown transcript', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.copyFileSync(sourcePath, result.filePath);
    return { canceled: false, filePath: result.filePath };
  });
  handle('captions:session-start', async (request) => {
    const result = await sessionManager.start(request);
    windows.applySelectedOutput();
    return result;
  });
  handle('captions:session-stop', async () => sessionManager.stop());
  handle('captions:session-status', () => sessionManager.snapshot());
  handle('captions:evaluation-rate', (rating) =>
    sessionManager.rateEvaluation(rating),
  );
  handle('captions:screening-prompt-set', (prompt) =>
    sessionManager.setScreeningPrompt(prompt),
  );
  handle('captions:shadow-abort', () => sessionManager.abortShadow());
  handle('captions:recordings-list', () => evaluationRecorder.list());
  handle('captions:windows-show', () => {
    windows.showAll();
    return windows.previewVisibility();
  });
  handle('captions:windows-hide', () => {
    windows.hideAll();
    return windows.previewVisibility();
  });
  handle('captions:camera-stage-show', () => {
    windows.showCameraStage();
    return windows.previewVisibility();
  });
  handle('captions:camera-stage-hide', () => {
    windows.hideCameraStage();
    return windows.previewVisibility();
  });
  handle('captions:preview-visibility-get', () => windows.previewVisibility());
  handle('captions:camera-stage-snapshot', () => windows.cameraStageSnapshot());
  const requireNativeCamera = () => {
    if (!nativeCameraSupervisor || !nativeCameraInstaller) {
      const error = new Error('Native camera is unavailable on this system');
      error.code = 'native_camera_unavailable';
      throw error;
    }
  };
  const publishNativeHealth = async () => {
    const health = nativeCameraSupervisor
      ? await nativeCameraSupervisor.refresh()
      : {
          state: 'unsupported',
          supported: false,
          installed: false,
          reason: 'windows-only',
          restartCount: 0,
          message: null,
          code: null,
        };
    windows.broadcastControl('captions:native-camera-health', health);
    return health;
  };
  handle('captions:native-camera-health-get', publishNativeHealth);
  handle('captions:native-camera-install', async () => {
    requireNativeCamera();
    await nativeCameraInstaller.install();
    const health = await publishNativeHealth();
    if (windows.outputMode === 'virtual-camera') windows.startCameraOutput();
    return health;
  });
  handle('captions:native-camera-repair', async () => {
    requireNativeCamera();
    await windows.stopCameraOutput();
    await nativeCameraInstaller.repair();
    const health = await publishNativeHealth();
    if (windows.outputMode === 'virtual-camera') windows.startCameraOutput();
    return health;
  });
  handle('captions:native-camera-remove', async () => {
    requireNativeCamera();
    await windows.stopCameraOutput();
    await nativeCameraInstaller.remove();
    return publishNativeHealth();
  });
  handle('captions:native-camera-retry', async () => {
    requireNativeCamera();
    const health = await nativeCameraSupervisor.start({ manual: true });
    windows.broadcastControl('captions:native-camera-health', health);
    if (
      windows.outputMode === 'virtual-camera' &&
      health.supported &&
      health.installed
    ) {
      windows.startCameraOutput();
    }
    return health;
  });
  handle('captions:layout-set', ({ layout }) => windows.applyLayout(layout));
  handle('captions:overlay-content-height', ({ audience, height, generation }, event) => {
    if (
      !['en', 'zh'].includes(audience) ||
      !Number.isFinite(height) ||
      height < 64 ||
      height > 2000
    ) {
      throw new Error('Invalid caption content height');
    }
    if (!Number.isInteger(generation) || generation < 0) {
      throw new Error('Invalid caption auto-size generation');
    }
    const window = windows.captionWindows.get(audience);
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.id !== event.sender.id
    ) {
      throw new Error('Caption height must come from its audience window');
    }
    return {
      audience,
      height: windows.reportContentHeight(audience, height, generation),
      generation,
    };
  });
  handle('captions:export', async ({ format = 'json' }) => {
    const extension = format === 'markdown' ? 'md' : 'json';
    const result = await dialog.showSaveDialog(windows.controlWindow, {
      title: 'Export Twinscript caption session',
      defaultPath: path.join(
        app.getPath('documents'),
        `twinscript-captions-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`,
      ),
      filters: [
        {
          name: format === 'markdown' ? 'Markdown' : 'JSON',
          extensions: [extension],
        },
      ],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, sessionManager.export(format), 'utf8');
    return { canceled: false, filePath: result.filePath };
  });
  handle('captions:open-privacy', () =>
    shell.openExternal('https://developers.openai.com/api/docs/guides/your-data'),
  );

  ipcMain.on('captions:audio', (event, payload) => {
    try {
      assertSender(event, windows);
      if (
        !payload ||
        !['microphone', 'system'].includes(payload.channel) ||
        !payload.samples
      ) {
        return;
      }
      sessionManager.appendAudio(payload);
    } catch {
      // High-volume audio transport fails closed without echoing payloads.
    }
  });
}

module.exports = { assertSender, registerCaptionIpc, safeResult };
