const { execFileSync } = require('child_process');

const LOCAL_MAC_SIGNING_IDENTITY =
  'Bilingual Meeting Captions Local Signing';

function hasCodeSigningIdentity(
  identity = LOCAL_MAC_SIGNING_IDENTITY,
  execFileSyncImpl = execFileSync,
) {
  try {
    const output = execFileSyncImpl(
      '/usr/bin/security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return String(output).includes(`"${identity}"`);
  } catch {
    return false;
  }
}

function resolveMacSigningIdentity({
  platform = process.platform,
  environment = process.env,
  execFileSyncImpl = execFileSync,
} = {}) {
  const requested = String(environment.MACOS_SIGN_IDENTITY || '').trim();
  if (requested) return requested;
  if (
    platform === 'darwin' &&
    hasCodeSigningIdentity(LOCAL_MAC_SIGNING_IDENTITY, execFileSyncImpl)
  ) {
    return LOCAL_MAC_SIGNING_IDENTITY;
  }
  return '-';
}

if (require.main === module) {
  const identity = resolveMacSigningIdentity();
  if (identity === '-') {
    console.error(
      `Missing "${LOCAL_MAC_SIGNING_IDENTITY}". Run npm run macos:signing:setup once.`,
    );
    process.exitCode = 1;
  } else {
    console.info(`macOS local signing identity is ready: ${identity}`);
  }
}

module.exports = {
  LOCAL_MAC_SIGNING_IDENTITY,
  hasCodeSigningIdentity,
  resolveMacSigningIdentity,
};
