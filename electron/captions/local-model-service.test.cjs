const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { LocalModelService } = require('./local-model-service');
const { LocalModelAdmissionGate } = require('./local-model-admission');

function catalog() {
  return {
    available: true,
    root: 'C:\\catalog',
    manifest: {
      runtimeVersion: '2026.8.10',
      models: [
        { id: 'whisper-small', version: 'whisper-v2', displayName: 'Whisper Small', purpose: 'Speech recognition', expectedDevice: 'NPU' },
        { id: 'hy-mt2-1.8b', version: 'hymt2-v2', displayName: 'HY-MT2 1.8B', purpose: 'Translation', expectedDevice: 'GPU' },
      ],
    },
    error: null,
  };
}

test('status merges model lifecycle, runtime device truth, and meeting action locks', () => {
  const manager = {
    status: () => ({
      runtimeVersion: '2026.8.10',
      models: {
        'whisper-small': { id: 'whisper-small', phase: 'ready', ready: true, expectedDevice: 'NPU' },
        'hy-mt2-1.8b': { id: 'hy-mt2-1.8b', phase: 'downloading', ready: false, expectedDevice: 'GPU' },
      },
    }),
  };
  const service = new LocalModelService({
    catalog: catalog(),
    manager,
    sessionManager: { isActive: () => true },
    supervisor: {
      readiness: () => ({
        runtimeReady: true,
        requestedDevice: 'NPU',
        models: {
          'whisper-small': { ready: true, actualDevice: 'NPU' },
          'hy-mt2-1.8b': { ready: false, actualDevice: 'CPU' },
        },
      }),
    },
  });

  const status = service.status();

  assert.ok(service instanceof EventEmitter);
  assert.equal(status.catalog.available, true);
  assert.equal('root' in status.catalog, false);
  assert.equal(status.runtime.ready, true);
  assert.equal(status.runtime.requestedDevice, 'NPU');
  assert.equal(status.models['whisper-small'].phase, 'ready');
  assert.equal(status.models['whisper-small'].actualDevice, 'NPU');
  assert.equal(status.models['hy-mt2-1.8b'].actualDevice, 'CPU');
  assert.deepEqual(status.actionLocks, {
    meetingActive: true,
    download: true,
    verify: true,
    repair: true,
    remove: true,
    adopt: true,
  });
});

test('modelReady reads the manager directly and an unavailable catalog exposes disabled rows', () => {
  let statusReads = 0;
  const service = new LocalModelService({
    catalog: {
      available: false,
      root: 'C:\\catalog',
      manifest: null,
      error: { code: 'local_catalog_unavailable', message: 'Local model downloads are unavailable in this build.' },
    },
    manager: {
      status: () => {
        statusReads += 1;
        return { models: { 'whisper-small': { ready: true } } };
      },
    },
    sessionManager: { isActive: () => false },
  });

  assert.equal(service.modelReady('whisper-small'), true);
  assert.equal(statusReads, 1);
  const status = service.status();

  assert.equal(status.catalog.available, false);
  assert.equal('root' in status.catalog, false);
  assert.equal(status.models['whisper-small'].phase, 'unavailable');
  assert.equal(status.models['hy-mt2-1.8b'].phase, 'unavailable');
  assert.equal(status.actionLocks.download, true);
});

test('status projects only renderer-safe model and catalog fields', () => {
  const service = new LocalModelService({
    catalog: catalog(),
    manager: {
      status: () => ({
        models: {
          'whisper-small': {
            id: 'whisper-small', phase: 'ready', ready: true, installed: true, verified: true,
            path: 'C:\\private\\model', url: 'https://private.invalid/model',
            sha256: 'a'.repeat(64), version: 'b'.repeat(64), signature: 'private-signature',
          },
          'hy-mt2-1.8b': { id: 'hy-mt2-1.8b', phase: 'not-installed', ready: false, installed: false, verified: false },
        },
      }),
    },
  });

  const status = service.status();
  const serialized = JSON.stringify(status);

  assert.equal(status.models['whisper-small'].version, 'whisper-v2');
  assert.equal(status.models['whisper-small'].installed, true);
  assert.equal(status.models['whisper-small'].verified, true);
  assert.equal(status.models['hy-mt2-1.8b'].version, 'hymt2-v2');
  assert.equal(status.models['hy-mt2-1.8b'].installed, false);
  assert.equal(status.models['hy-mt2-1.8b'].verified, false);

  for (const secret of ['C:\\private\\model', 'https://private.invalid/model', 'private-signature', 'a'.repeat(64), 'b'.repeat(64)]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('status defaults an unsafe requested runtime device without leaking it', () => {
  const service = new LocalModelService({
    catalog: catalog(),
    manager: {
      status: () => ({
        models: {
          'whisper-small': { id: 'whisper-small', phase: 'ready', ready: true },
          'hy-mt2-1.8b': { id: 'hy-mt2-1.8b', phase: 'ready', ready: true },
        },
      }),
    },
    supervisor: {
      readiness: () => ({
        runtimeReady: true,
        requestedDevice: 'C:\\private\\runtime',
        models: {},
      }),
    },
  });

  const status = service.status();

  assert.equal(status.runtime.requestedDevice, 'NPU');
  assert.equal(JSON.stringify(status).includes('C:\\private\\runtime'), false);
});

test('install publishes a fresh status after a manager operation succeeds or fails', async () => {
  let fail = false;
  const service = new LocalModelService({
    catalog: catalog(),
    manager: {
      status: () => ({
        models: {
          'whisper-small': { id: 'whisper-small', phase: fail ? 'failed' : 'ready', ready: !fail },
          'hy-mt2-1.8b': { id: 'hy-mt2-1.8b', phase: 'not-installed', ready: false },
        },
      }),
      download: async () => {
        if (fail) throw Object.assign(new Error('network down'), { code: 'local_model_download_failed' });
        return { id: 'whisper-small', ready: true };
      },
    },
  });
  const events = [];
  service.on('status', (status) => events.push(status));

  await service.install('whisper-small');
  fail = true;
  await assert.rejects(service.install('whisper-small'), { code: 'local_model_download_failed' });

  assert.equal(events.length, 2);
  assert.equal(events[0].models['whisper-small'].phase, 'ready');
  assert.equal(events[1].models['whisper-small'].phase, 'failed');
});

test('operations reject unavailable catalogs, active meetings, and unknown model IDs', async () => {
  const unavailable = new LocalModelService({
    catalog: { available: false, manifest: null, error: { code: 'local_catalog_unavailable', message: 'Unavailable' } },
  });
  await assert.rejects(unavailable.install('whisper-small'), { code: 'local_catalog_unavailable' });

  const active = new LocalModelService({
    catalog: catalog(),
    manager: { download: async () => { throw new Error('unused'); } },
    sessionManager: { isActive: () => true },
  });
  await assert.rejects(active.install('whisper-small'), { code: 'meeting_active' });

  const known = new LocalModelService({
    catalog: catalog(),
    manager: { download: async () => { throw new Error('unused'); } },
  });
  await assert.rejects(known.install('unknown'), { code: 'local_model_unknown' });
});

test('a local-only development catalog permits adoption but never enables download', async () => {
  let adopted = false;
  const localCatalog = { ...catalog(), localAdoptionAvailable: true };
  for (const model of localCatalog.manifest.models) model.localOnly = true;
  const service = new LocalModelService({
    catalog: localCatalog,
    manager: {
      status: () => ({ models: {
        'whisper-small': { id: 'whisper-small', phase: adopted ? 'ready' : 'not-installed', ready: adopted },
        'hy-mt2-1.8b': { id: 'hy-mt2-1.8b', phase: 'not-installed', ready: false },
      } }),
      adopt: async () => { adopted = true; },
      download: async () => { throw new Error('must not download'); },
    },
  });

  await assert.rejects(service.install('whisper-small'), { code: 'local_model_local_files_only' });
  await service.adopt('whisper-small');

  const status = service.status();
  assert.equal(status.catalog.localAdoptionAvailable, true);
  assert.equal(status.actionLocks.download, true);
  assert.equal(status.actionLocks.adopt, false);
  assert.equal(status.models['whisper-small'].ready, true);
});

test('a queued session admission wins the mutation gate before a manager operation begins', async () => {
  const gate = new LocalModelAdmissionGate();
  const releaseSession = await gate.acquireSession();
  let called = false;
  const service = new LocalModelService({
    catalog: catalog(),
    admissionGate: gate,
    manager: {
      download: async () => { called = true; },
      status: () => ({ models: {} }),
    },
  });

  await assert.rejects(service.install('whisper-small'), { code: 'meeting_active' });
  assert.equal(called, false);
  releaseSession();
});
