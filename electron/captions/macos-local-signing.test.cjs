const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LOCAL_MAC_SIGNING_IDENTITY,
  hasCodeSigningIdentity,
  resolveMacSigningIdentity,
} = require('../../scripts/macos-local-signing.cjs');

test('local macOS signing selects the stable identity when installed', () => {
  const execute = () =>
    `1) ABCDEF1234 "${LOCAL_MAC_SIGNING_IDENTITY}"\n  1 valid identities found`;
  assert.equal(hasCodeSigningIdentity(LOCAL_MAC_SIGNING_IDENTITY, execute), true);
  assert.equal(
    resolveMacSigningIdentity({
      platform: 'darwin',
      environment: {},
      execFileSyncImpl: execute,
    }),
    LOCAL_MAC_SIGNING_IDENTITY,
  );
});

test('local macOS signing retains an explicit ad-hoc fallback', () => {
  assert.equal(
    resolveMacSigningIdentity({
      platform: 'darwin',
      environment: {},
      execFileSyncImpl: () => '0 valid identities found',
    }),
    '-',
  );
});

test('an explicitly requested signing identity takes priority', () => {
  assert.equal(
    resolveMacSigningIdentity({
      platform: 'darwin',
      environment: { MACOS_SIGN_IDENTITY: 'Developer ID Application: Example' },
      execFileSyncImpl: () => {
        throw new Error('should not inspect Keychain');
      },
    }),
    'Developer ID Application: Example',
  );
});
