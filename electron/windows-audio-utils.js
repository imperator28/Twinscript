/**
 * Windows system-audio capture hooks used by the caption client.
 *
 * Electron performs the actual loopback capture in the renderer. These hooks
 * keep the cross-platform IPC contract uniform without installing or managing
 * a virtual microphone driver.
 */

async function supportsSystemAudioCapture() {
  return true;
}

async function listSystemAudioSources() {
  return [{
    deviceId: 'desktop-audio-loopback',
    label: 'System Audio (All Applications)',
  }];
}

async function connectSystemAudioSource() {
  return { success: true };
}

async function disconnectSystemAudioSource() {
  return { success: true };
}

module.exports = {
  supportsSystemAudioCapture,
  listSystemAudioSources,
  connectSystemAudioSource,
  disconnectSystemAudioSource,
};
