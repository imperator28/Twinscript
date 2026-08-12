# Development Local Model Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a development build verify and adopt the two fixed local model builds a reviewer places in the documented folders, without adding a downloader or weakening packaged-build signing.

**Architecture:** A development-only catalog describes the exact Whisper Small OpenVINO files and HY-MT2 CPU GGUF artifact. A new `adopt` lifecycle operation performs the existing hash verification and writes the existing verified marker without fetching. The renderer exposes this only when the catalog declares local adoption; packaged builds require the normal signed release catalog and never expose adoption.

**Tech Stack:** Electron main/preload IPC, CommonJS model lifecycle, React/Vitest, Node test runner.

---

### Task 1: Describe the development catalog and local-file operation

**Files:**

- Create: `electron/captions/local-model-development-catalog.js`
- Modify: `electron/captions/local-model-manifest.js`
- Test: `electron/captions/local-model-manifest-loader.test.cjs`

- [ ] **Step 1: Write a failing test**

```js
test('loads the development local-file catalog only for an unpackaged build', () => {
  const result = loadLocalModelCatalog({ isPackaged: false, appPath: fixtureRoot });
  assert.equal(result.available, true);
  assert.equal(result.localAdoptionAvailable, true);
  assert.deepEqual(result.manifest.models.map(({ id }) => id), ['whisper-small', 'hy-mt2-1.8b']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test electron/captions/local-model-manifest-loader.test.cjs`

Expected: FAIL because the catalog has no local-adoption property or fixture.

- [ ] **Step 3: Implement the minimal catalog boundary**

```js
function developmentCatalog({ appPath }) {
  return { available: true, localAdoptionAvailable: true, root: path.join(appPath, 'native', 'local-inference-host', 'models'), manifest };
}
```

Keep packaged catalog validation unchanged; accept the development catalog only when `isPackaged` is false.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test electron/captions/local-model-manifest-loader.test.cjs`

Expected: PASS.

### Task 2: Verify and adopt already-present files

**Files:**

- Modify: `electron/captions/local-model-manager.js`
- Modify: `electron/captions/local-model-service.js`
- Test: `electron/captions/local-model-manager.test.cjs`
- Test: `electron/captions/local-model-service.test.cjs`

- [ ] **Step 1: Write failing tests**

```js
test('adopt verifies existing hashes and writes a ready marker without fetching', async () => {
  const { manager, fetchCalls } = managerWithPlacedFiles();
  await manager.adopt('whisper-small');
  assert.equal(manager.status().models['whisper-small'].ready, true);
  assert.equal(fetchCalls(), 0);
});

test('adopt rejects a corrupt local file and leaves the model repair-needed', async () => {
  const { manager } = managerWithPlacedFiles({ corrupt: true });
  await assert.rejects(manager.adopt('hy-mt2-1.8b'), { code: 'local_model_hash_mismatch' });
  assert.equal(manager.status().models['hy-mt2-1.8b'].phase, 'repair-needed');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test electron/captions/local-model-manager.test.cjs electron/captions/local-model-service.test.cjs`

Expected: FAIL because `adopt` is not implemented.

- [ ] **Step 3: Implement the minimal adoption operation**

```js
async adopt(modelId) {
  return this._withMutation(modelId, 'verifying', async (model) => {
    await this._verifyFiles(model);
    this.failures.delete(model.id);
    const total = model.files.reduce((sum, file) => sum + file.size, 0);
    this._emit(model.id, 'ready', total, total);
    return this.status().models[model.id];
  });
}
```

Expose the operation through `LocalModelService` only when the catalog has `localAdoptionAvailable`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test electron/captions/local-model-manager.test.cjs electron/captions/local-model-service.test.cjs`

Expected: PASS.

### Task 3: Expose local-file adoption in the development UI only

**Files:**

- Modify: `electron/captions/register-caption-ipc.js`
- Modify: `electron/captions-preload.js`
- Modify: `src/captions/types.ts`
- Modify: `src/captions/ControlApp.tsx`
- Modify: `src/captions/LocalModelInstallCard.tsx`
- Test: `electron/captions/local-model-ipc.test.cjs`
- Test: `src/captions/ControlApp.test.tsx`
- Test: `src/captions/LocalModelInstallCard.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
it('offers Use local files for a development catalog with an unadopted model', () => {
  render(<LocalModelInstallCard status={localDevelopmentStatus()} onAction={onAction} />);
  fireEvent.click(screen.getByRole('button', { name: 'Use local Whisper local transcription model files' }));
  expect(onAction).toHaveBeenCalledWith('adopt', 'whisper-small');
});
```

```js
test('adopt IPC rejects a packaged catalog without local adoption enabled', async () => {
  const result = await harness.invoke('captions:local-model-adopt', { modelId: 'whisper-small' });
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test electron/captions/local-model-ipc.test.cjs; npm test -- --run src/captions/ControlApp.test.tsx src/captions/LocalModelInstallCard.test.tsx`

Expected: FAIL because the adopt operation and UI action do not exist.

- [ ] **Step 3: Implement narrow IPC and UI action**

```ts
export type LocalModelAction = 'install' | 'verify' | 'repair' | 'remove' | 'adopt';
```

Render `Use local files` only for an unpackaged catalog with local adoption enabled. Keep Install unavailable until a signed release catalog provides real HTTPS assets.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test electron/captions/local-model-ipc.test.cjs; npm test -- --run src/captions/ControlApp.test.tsx src/captions/LocalModelInstallCard.test.tsx`

Expected: PASS.

### Task 4: Stage the reviewer artifacts and verify end to end

**Files:**

- Create: `scripts/stage-development-local-models.mjs`
- Test: `scripts/stage-development-local-models.test.cjs`

- [ ] **Step 1: Write a failing test**

```js
test('stages only the manifest-declared local files into versioned model folders', async () => {
  await stageDevelopmentModels({ sourceRoot, targetRoot, manifest });
  assert.equal(fs.existsSync(path.join(targetRoot, 'whisper-small', manifest.models[0].version, 'openvino_encoder_model.xml')), true);
  assert.equal(fs.existsSync(path.join(targetRoot, 'hy-mt2-1.8b', manifest.models[1].version, manifest.models[1].launchPath)), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/stage-development-local-models.test.cjs`

Expected: FAIL because the staging script does not exist.

- [ ] **Step 3: Implement staging with copy-on-write-safe file copies**

The script copies exactly the known Whisper export and HY-MT2 GGUF files from the existing feasibility artifacts, refuses mismatched hashes, and writes no verified marker. The user must click `Use local files`, making adoption an explicit verification step.

- [ ] **Step 4: Run final verification**

Run: `node --test electron/captions/local-model-*.test.cjs scripts/stage-development-local-models.test.cjs; npm test -- --run src/captions/ControlApp.test.tsx src/captions/LocalModelInstallCard.test.tsx; npm run build`

Expected: all tests and the production build pass; packaged builds retain the signed-catalog requirement.
