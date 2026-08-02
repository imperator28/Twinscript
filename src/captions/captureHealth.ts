// Per-channel capture health, kept pure so the Windows and macOS paths can be
// asserted without a real audio device.
//
// Two rules from the Windows work package drive this module:
//   * If meeting/system capture fails, microphone captions continue and the
//     operator sees a persistent, actionable warning — not a dismissible toast.
//   * The meeting channel is never described as live while its RMS and
//     sent-audio counters are both zero.

export type CapturePlatform = 'win32' | 'darwin' | 'linux' | 'unknown';

export type ChannelHealthState =
  | 'idle'
  | 'unavailable'
  | 'waiting'
  | 'silent'
  | 'live';

export interface ChannelHealth {
  state: ChannelHealthState;
  label: string;
  detail?: string;
}

/** How long a started channel may deliver nothing before it reads as silent. */
export const CAPTURE_GRACE_MS = 4000;

/** Above this RMS the channel is carrying audible signal rather than noise. */
export const AUDIBLE_RMS = 0.002;

export function detectCapturePlatform(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): CapturePlatform {
  if (/Windows/i.test(userAgent)) return 'win32';
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'darwin';
  if (/Linux|X11/i.test(userAgent)) return 'linux';
  return 'unknown';
}

/**
 * The operator-facing explanation for a failed meeting/system capture.
 *
 * Windows loopback goes through Electron's display-media handler and has no
 * permission gate, so telling a Windows user to grant Screen Recording sends
 * them to a setting that does not exist. Each platform gets the step that
 * actually recovers it.
 */
export function describeSystemCaptureFailure({
  platform,
  error,
}: {
  platform: CapturePlatform;
  error?: unknown;
}): string {
  const reason = error instanceof Error ? error.message : '';
  const suffix = reason ? ` (${reason})` : '';

  if (platform === 'win32') {
    return (
      'Microphone captions are live. Meeting audio is not being captured: ' +
      'confirm Windows is playing the meeting through an active output device, ' +
      'then end and restart the session' +
      suffix +
      '.'
    );
  }
  if (platform === 'darwin') {
    return (
      'Microphone captions are live. Meeting audio is not being captured: ' +
      'grant Screen Recording to Twinscript in System Settings → ' +
      'Privacy & Security, then end and restart the session' +
      suffix +
      '.'
    );
  }
  if (platform === 'linux') {
    return (
      'Microphone captions are live. Meeting audio is not being captured: ' +
      'confirm a PulseAudio or PipeWire monitor source is available, then end ' +
      'and restart the session' +
      suffix +
      '.'
    );
  }
  return (
    'Microphone captions are live. Meeting audio is not being captured' +
    suffix +
    '.'
  );
}

/**
 * Describe one capture channel.
 *
 * `capturing` is whether the renderer actually holds a live recorder for the
 * channel; `sentAudioMs` and `rms` come from the main process. A channel that
 * never started is `unavailable`, and a started channel only reaches `live`
 * once audio has demonstrably moved.
 */
export function deriveChannelHealth({
  sessionActive,
  capturing,
  sentAudioMs = 0,
  rms = 0,
  msSinceStart = 0,
  graceMs = CAPTURE_GRACE_MS,
}: {
  sessionActive: boolean;
  capturing: boolean;
  sentAudioMs?: number;
  rms?: number;
  msSinceStart?: number;
  graceMs?: number;
}): ChannelHealth {
  if (!sessionActive) return { state: 'idle', label: 'IDLE' };
  if (!capturing) {
    return {
      state: 'unavailable',
      label: 'UNAVAILABLE',
      detail: 'This channel is not being captured.',
    };
  }
  if (sentAudioMs > 0 || rms > AUDIBLE_RMS) {
    return { state: 'live', label: 'LIVE' };
  }
  if (msSinceStart < graceMs) {
    return {
      state: 'waiting',
      label: 'STARTING',
      detail: 'Waiting for the first audio from this channel.',
    };
  }
  return {
    state: 'silent',
    label: 'NO AUDIO',
    detail: 'Capture started but no audio has arrived from this channel yet.',
  };
}
