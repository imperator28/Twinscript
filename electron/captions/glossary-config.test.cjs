const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ACTIVE_TERM_LIMIT,
  BUILTIN_GLOSSARY_CONFIGURATIONS,
  CORE_PRODUCT_DEVELOPMENT_TOKENS,
  compileGlossarySelection,
  createPortableConfiguration,
  describeEffectiveGlossary,
  listGlossaryConfigurations,
  parseGlossaryContent,
  sanitizeConfiguration,
} = require('./glossary-config');
const {
  findProtectedTokens,
  glossaryPrompt,
  OpenAINormalizer,
} = require('./openai-normalizer');
const { SettingsStore } = require('./settings-store');
const { registerCaptionIpc } = require('./register-caption-ipc');
const { CaptionSessionManager } = require('./caption-session-manager');

test('one universal engineering glossary combines every meeting domain', () => {
  const summaries = listGlossaryConfigurations();
  assert.equal(summaries.length, 1);
  assert.equal(BUILTIN_GLOSSARY_CONFIGURATIONS.length, 1);
  const southChina = BUILTIN_GLOSSARY_CONFIGURATIONS[0];
  assert.equal(southChina.id, 'universal-engineering');
  assert.ok(southChina.terms.length > ACTIVE_TERM_LIMIT);
  assert.ok(southChina.terms.every((entry) => entry.en && entry.zh));
  for (const representative of [
    'boss',
    'CNC machining',
    'root cause analysis',
    'mould trial',
  ]) {
    assert.ok(
      southChina.terms.some((entry) => entry.en === representative),
      `missing ${representative}`,
    );
  }
  assert.equal(
    new Set(
      southChina.terms.map(
        (entry) =>
          `${entry.en.trim().toLocaleLowerCase('en-US')}\0${entry.zh
            .trim()
            .toLocaleLowerCase()}`,
      ),
    ).size,
    southChina.terms.length,
  );
  assert.deepEqual(southChina.regions, ['Guangdong', 'Shenzhen', 'Dongguan']);
  assert.ok(
    southChina.terms
      .find((entry) => entry.en === 'flash')
      .aliases.includes('批锋'),
  );
});

test('universal glossary carries canonical product-development tokens', () => {
  const compiled = compileGlossarySelection('mechanical-product-design', null);
  assert.equal(compiled.glossaryConfigurationId, 'universal-engineering');
  for (const token of ['T1', 'T2', 'EVT', 'DVT', 'PVT', 'NPI']) {
    assert.ok(CORE_PRODUCT_DEVELOPMENT_TOKENS.includes(token));
    assert.ok(compiled.protectedTokens.includes(token));
  }
  assert.equal(compiled.glossary.length, ACTIVE_TERM_LIMIT);
  assert.ok(compiled.glossaryStoredCount > compiled.glossary.length);
});

test('custom terms override built-ins and do not consume protected-token slots', () => {
  const compiled = compileGlossarySelection('mechanical-product-design', {
    schemaVersion: 1,
    id: 'project-falcon',
    name: 'Project Falcon',
    description: '',
    regions: [],
    domains: [],
    protectedTokens: ['pvt', 'ABC-123'],
    terms: [
      {
        en: 'boss',
        zh: '凸柱',
        aliases: ['凸台'],
        priority: 5,
      },
    ],
  });
  assert.equal(compiled.glossary[0].en, 'boss');
  assert.equal(compiled.glossary[0].zh, '凸柱');
  assert.ok(compiled.glossary[0].aliases.includes('凸台'));
  assert.equal(
    compiled.protectedTokens.filter((token) => token.toLowerCase() === 'pvt')
      .length,
    1,
  );
  assert.ok(compiled.protectedTokens.includes('PVT'));
  assert.ok(compiled.protectedTokens.includes('ABC-123'));
});

test('legacy and unknown configuration IDs normalize without losing custom data', () => {
  for (const legacyId of [
    'mechanical-product-design',
    'manufacturing-dfm',
    'manufacturing-quality',
    'south-china-tooling',
    'unknown-meeting-type',
  ]) {
    const compiled = compileGlossarySelection(legacyId, {
      schemaVersion: 1,
      id: 'project-falcon',
      name: 'Project Falcon',
      protectedTokens: ['ABC-123'],
      terms: [{ en: 'project falcon', zh: '猎鹰项目', priority: 5 }],
    });
    assert.equal(compiled.glossaryConfigurationId, 'universal-engineering');
    assert.equal(compiled.glossary[0].en, 'project falcon');
    assert.ok(compiled.protectedTokens.includes('ABC-123'));
  }
});

test('JSON, CSV, TSV, and TXT imports normalize into portable configurations', () => {
  const json = parseGlossaryContent({
    extension: 'json',
    fileName: 'supplier',
    text: JSON.stringify({
      schemaVersion: 1,
      id: 'supplier',
      name: 'Supplier',
      description: '<b>Private</b>\u0000 terms',
      regions: ['Shenzhen'],
      domains: ['tooling'],
      protectedTokens: ['Gate-4'],
      terms: [{ en: 'flash', zh: '飞边', aliases: ['批锋'], priority: 5 }],
    }),
  });
  assert.equal(json.configuration.description, 'Private terms');
  assert.deepEqual(json.configuration.protectedTokens, ['Gate-4']);

  const csv = parseGlossaryContent({
    extension: 'csv',
    fileName: 'csv-file',
    text:
      'en,zh,aliases,doNotTranslate,priority\n' +
      'flash,飞边,批锋|披锋,false,5\n' +
      'flash,飞边,披锋,false,4\n' +
      'missing,,,,3\n',
  });
  assert.equal(csv.configuration.terms.length, 1);
  assert.equal(csv.duplicateCount, 1);
  assert.deepEqual(csv.rejectedRows, [4]);

  const tsv = parseGlossaryContent({
    extension: 'tsv',
    fileName: 'tsv-file',
    text: 'en\tzh\taliases\nboss\t凸台\t凸柱\n',
  });
  assert.equal(tsv.configuration.terms[0].zh, '凸台');

  const txt = parseGlossaryContent({
    extension: 'txt',
    fileName: 'txt-file',
    text: '# project terms\nwall thickness = 壁厚\ninvalid row\n',
  });
  assert.equal(txt.configuration.terms[0].en, 'wall thickness');
  assert.deepEqual(txt.rejectedRows, [3]);
});

test('portable JSON re-imports without losing terms or protected tokens', () => {
  const settings = compileGlossarySelection('south-china-tooling', {
    schemaVersion: 1,
    id: 'custom',
    name: 'Custom',
    description: '',
    regions: [],
    domains: [],
    protectedTokens: ['ABC-123'],
    terms: [{ en: 'project colour', zh: '项目颜色', priority: 5 }],
  });
  const exported = createPortableConfiguration(settings);
  const imported = parseGlossaryContent({
    extension: 'json',
    fileName: 'portable',
    text: JSON.stringify(exported),
  }).configuration;
  assert.equal(imported.terms.length, exported.terms.length);
  assert.deepEqual(imported.protectedTokens, exported.protectedTokens);
});

test('legacy flat glossary migrates into custom overrides', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-settings-'));
  fs.writeFileSync(
    path.join(userData, 'caption-settings.json'),
    JSON.stringify({
      settingsVersion: 4,
      glossary: [{ en: 'project falcon', zh: '猎鹰项目' }],
    }),
  );
  const settings = new SettingsStore({ getPath: () => userData }).get();
  assert.equal(settings.settingsVersion, 14);
  assert.equal(settings.customGlossaryConfiguration.terms[0].en, 'project falcon');
  assert.equal(settings.glossary[0].en, 'project falcon');
  assert.ok(settings.protectedTokens.includes('PVT'));
  fs.rmSync(userData, { recursive: true, force: true });
});

test('normalizer preserves and canonicalizes protected tokens in both languages', async () => {
  let attempts = 0;
  const usageEvents = [];
  const normalizer = new OpenAINormalizer({
    apiKey: 'test-key',
    onUsage: (usage) => usageEvents.push(usage),
    fetchImpl: async (_url, options) => {
      attempts += 1;
      const request = JSON.parse(options.body);
      assert.match(
        request.input[0].content[0].text,
        /Protected literal tokens.*PVT/,
      );
      const text = attempts === 1 ? '生产验证测试将在周五开始。' : 'Pvt 试产将在周五开始。';
      return {
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({ source_language: 'en', text }),
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
        headers: new Map([['x-request-id', `request-${attempts}`]]),
      };
    },
  });
  const result = await normalizer.normalize({
    sourceText: 'The pvt build starts Friday.',
    target: 'zh',
    profile: 'economy',
    final: true,
    protectedTokens: ['PVT'],
  });
  assert.equal(attempts, 2);
  assert.equal(result.text, 'PVT 试产将在周五开始。');
  assert.deepEqual(findProtectedTokens(result.text, ['PVT']), ['PVT']);
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(usageEvents.length, 2);
  assert.match(glossaryPrompt([], ['T1', 'PVT']), /T1, PVT/);
});

test('live transcription receives protected product-development keywords', async () => {
  const transcriptionOptions = [];
  const compiled = compileGlossarySelection('mechanical-product-design', null);
  const manager = new CaptionSessionManager({
    credentialStore: { get: async () => 'test-key' },
    settingsStore: {
      get: () => ({
        ...compiled,
        budgetUsd: 5,
        shadowEnabled: false,
        recordEvaluation: false,
        reorderWindowMs: 400,
        duplicateWindowMs: 1400,
      }),
      set: () => {},
    },
    transcriptionFactory: (options) => {
      transcriptionOptions.push(options);
      return {
        connect: async () => {},
        close: () => {},
        appendAudio: () => {},
      };
    },
    normalizerFactory: () => ({ normalize: async () => ({}) }),
  });
  await manager.start({ mode: 'live' });
  assert.equal(transcriptionOptions.length, 2);
  assert.ok(transcriptionOptions.every((options) => options.keywords.includes('PVT')));
  assert.ok(transcriptionOptions.every((options) => options.keywords.includes('T2')));
  await manager.stop();
});

test('configuration validation rejects unsupported schemas', () => {
  assert.throws(
    () => sanitizeConfiguration({ schemaVersion: 2, name: 'Future', terms: [] }),
    /schemaVersion must be 1/,
  );
  assert.throws(
    () =>
      parseGlossaryContent({
        extension: 'xlsx',
        fileName: 'unsupported',
        text: '',
      }),
    /\.json, \.csv, \.tsv, or \.txt/,
  );
});

test('glossary file operations reject untrusted renderer senders', async () => {
  const handlers = new Map();
  let confirmationResponse = 0;
  let credentialRepairs = 0;
  registerCaptionIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => {},
    },
    app: { getPath: () => os.tmpdir() },
    dialog: {
      showOpenDialog: async () => ({ canceled: true }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: confirmationResponse }),
    },
    shell: { openExternal: async () => {} },
    windows: {
      controlWindow: {
        isDestroyed: () => false,
        webContents: { id: 10 },
      },
      captionWindows: new Map(),
      broadcast: () => {},
      showAll: () => {},
      hideAll: () => {},
      applyLayout: () => {},
    },
    sessionManager: {
      snapshot: () => ({}),
      export: () => '',
      rateEvaluation: () => ({}),
      setScreeningPrompt: () => null,
      abortShadow: () => ({}),
      start: async () => ({}),
      stop: async () => ({}),
    },
    settingsStore: {
      get: () => compileGlossarySelection('south-china-tooling', null),
      set: () => compileGlossarySelection('south-china-tooling', null),
    },
    credentialStore: {
      status: () => ({}),
      set: () => ({}),
      delete: () => ({}),
      repair: () => {
        credentialRepairs += 1;
        return { available: false, relaunchRequired: false };
      },
      validate: () => ({}),
    },
    evaluationRecorder: { list: () => [] },
    requestMicrophoneAccess: () => ({}),
  });
  const result = await handlers.get('captions:glossary-export')({
    sender: { id: 99 },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Untrusted IPC sender/);

  const canceledRepair = await handlers.get('captions:credential-repair')({
    sender: { id: 10 },
  });
  assert.equal(canceledRepair.ok, true);
  assert.equal(canceledRepair.data.canceled, true);
  assert.equal(credentialRepairs, 0);

  confirmationResponse = 1;
  const confirmedRepair = await handlers.get('captions:credential-repair')({
    sender: { id: 10 },
  });
  assert.equal(confirmedRepair.ok, true);
  assert.equal(confirmedRepair.data.canceled, false);
  assert.equal(credentialRepairs, 1);
});

test('describeEffectiveGlossary reports stored terms and marks which are sent', () => {
  // The card counted STORED terms (138) while the viewer showed compileGlossarySelection's
  // `glossary`, which is already sliced to ACTIVE_TERM_LIMIT (40). Both numbers were true
  // and neither said what it measured, so the UI appeared to contradict itself.
  const described = describeEffectiveGlossary('universal-engineering', null);

  assert.equal(described.activeLimit, ACTIVE_TERM_LIMIT);
  assert.ok(
    described.terms.length > ACTIVE_TERM_LIMIT,
    'the built-in glossary is larger than the active cap, which is the whole point',
  );
  assert.equal(
    described.terms.length,
    described.storedCount,
    'every stored term is described, not just the active subset',
  );

  const active = described.terms.filter((term) => term.active);
  assert.equal(active.length, ACTIVE_TERM_LIMIT);
  // Active terms are a prefix: the ordering is what decides which ones reach the model.
  assert.ok(
    described.terms.slice(0, ACTIVE_TERM_LIMIT).every((term) => term.active),
    'the first N terms are the active ones',
  );
  assert.ok(
    described.terms.slice(ACTIVE_TERM_LIMIT).every((term) => !term.active),
    'everything past the cap is marked inactive rather than omitted',
  );
});

test('describeEffectiveGlossary marks the operator own rows and sorts them first', () => {
  const described = describeEffectiveGlossary('universal-engineering', {
    schemaVersion: 1,
    id: 'custom-overrides',
    name: 'Custom overrides',
    description: '',
    regions: [],
    domains: [],
    protectedTokens: ['ABC-123'],
    terms: [{ en: 'gasket', zh: '垫片', priority: 9 }],
  });

  const mine = described.terms.filter((term) => term.source === 'custom');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].en, 'gasket');
  // Marked so the editor knows which rows it may change, and active so an override the
  // operator just typed is not silently pushed past the cap by built-in terms.
  assert.equal(mine[0].active, true);
  assert.ok(described.protectedTokens.includes('ABC-123'));
});
