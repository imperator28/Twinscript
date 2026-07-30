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
  requestMicrophoneAccess,
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
  handle('captions:credential-validate', ({ value }) =>
    credentialStore.validate(value),
  );
  handle('captions:microphone-request', () => requestMicrophoneAccess());
  handle('captions:settings-get', () => settingsStore.get());
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
    const settings = settingsStore.set(patch);
    if (patch.layout) windows.applyLayout(patch.layout);
    if (patch.captionPaceMs !== undefined) {
      windows.setCaptionPaceMs(settings.captionPaceMs);
    }
    windows.broadcast('captions:settings', settings);
    return settings;
  });
  handle('captions:session-start', async (request) => {
    const result = await sessionManager.start(request);
    windows.showAll();
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
  handle('captions:windows-show', () => windows.showAll());
  handle('captions:windows-hide', () => windows.hideAll());
  handle('captions:layout-set', ({ layout }) => windows.applyLayout(layout));
  handle('captions:export', async ({ format = 'json' }) => {
    const extension = format === 'markdown' ? 'md' : 'json';
    const result = await dialog.showSaveDialog(windows.controlWindow, {
      title: 'Export bilingual caption session',
      defaultPath: path.join(
        app.getPath('documents'),
        `bilingual-captions-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`,
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
