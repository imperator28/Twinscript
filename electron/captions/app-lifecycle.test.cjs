const assert = require('node:assert/strict');
const test = require('node:test');
const {
  registerControlWindowLifecycle,
  shouldQuitOnControlWindowClose,
} = require('./app-lifecycle');

function fakeWindow() {
  const handlers = new Map();
  return {
    on(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    emit(event) {
      handlers.get(event)?.();
    },
  };
}

test('closing the control window ends the app on Windows and Linux', () => {
  for (const platform of ['win32', 'linux']) {
    let quits = 0;
    const controlWindow = fakeWindow();
    registerControlWindowLifecycle({
      app: { quit: () => (quits += 1) },
      controlWindow,
      platform,
    });
    assert.equal(quits, 0);
    controlWindow.emit('closed');
    assert.equal(quits, 1, `expected quit on ${platform}`);
  }
});

test('closing the control window leaves the app running on macOS', () => {
  let quits = 0;
  const controlWindow = fakeWindow();
  registerControlWindowLifecycle({
    app: { quit: () => (quits += 1) },
    controlWindow,
    platform: 'darwin',
  });
  controlWindow.emit('closed');
  assert.equal(quits, 0);
});

test('the caller drops its window reference before the quit decision', () => {
  const order = [];
  const controlWindow = fakeWindow();
  registerControlWindowLifecycle({
    app: { quit: () => order.push('quit') },
    controlWindow,
    platform: 'win32',
    onClosed: () => order.push('onClosed'),
  });
  controlWindow.emit('closed');
  assert.deepEqual(order, ['onClosed', 'quit']);
});

test('the reference is dropped on macOS even though the app keeps running', () => {
  const order = [];
  const controlWindow = fakeWindow();
  registerControlWindowLifecycle({
    app: { quit: () => order.push('quit') },
    controlWindow,
    platform: 'darwin',
    onClosed: () => order.push('onClosed'),
  });
  controlWindow.emit('closed');
  assert.deepEqual(order, ['onClosed']);
});

test('the platform rule is explicit about which platforms quit', () => {
  assert.equal(shouldQuitOnControlWindowClose('win32'), true);
  assert.equal(shouldQuitOnControlWindowClose('linux'), true);
  assert.equal(shouldQuitOnControlWindowClose('darwin'), false);
});
