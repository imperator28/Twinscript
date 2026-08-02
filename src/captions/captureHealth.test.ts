import { describe, expect, it } from 'vitest';
import {
  AUDIBLE_RMS,
  CAPTURE_GRACE_MS,
  deriveChannelHealth,
  describeSystemCaptureFailure,
  detectCapturePlatform,
} from './captureHealth';

describe('capture platform detection', () => {
  it('recognizes the platforms the client ships on', () => {
    expect(detectCapturePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('win32');
    expect(detectCapturePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('darwin');
    expect(detectCapturePlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(detectCapturePlatform('something else')).toBe('unknown');
  });
});

describe('system capture failure guidance', () => {
  it('does not send Windows users to a permission that does not exist', () => {
    const message = describeSystemCaptureFailure({ platform: 'win32' });
    expect(message).not.toMatch(/Screen Recording/i);
    expect(message).toMatch(/output device/i);
  });

  it('sends macOS users to Screen Recording', () => {
    const message = describeSystemCaptureFailure({ platform: 'darwin' });
    expect(message).toMatch(/Screen Recording/);
    expect(message).toMatch(/Privacy & Security/);
  });

  it('points Linux users at the monitor source', () => {
    expect(describeSystemCaptureFailure({ platform: 'linux' })).toMatch(
      /PulseAudio or PipeWire monitor source/,
    );
  });

  it('always states that microphone captions continue', () => {
    for (const platform of ['win32', 'darwin', 'linux', 'unknown'] as const) {
      expect(describeSystemCaptureFailure({ platform })).toMatch(
        /Microphone captions are live/,
      );
    }
  });

  it('appends the underlying reason when one is available', () => {
    expect(
      describeSystemCaptureFailure({
        platform: 'win32',
        error: new Error('No audio track in loopback stream'),
      }),
    ).toContain('(No audio track in loopback stream)');
  });

  it('tolerates a non-Error rejection', () => {
    const message = describeSystemCaptureFailure({
      platform: 'win32',
      error: 'plain string',
    });
    expect(message).not.toContain('plain string');
    expect(message).toMatch(/output device/i);
  });
});

describe('channel health', () => {
  const base = { sessionActive: true, capturing: true };

  it('is idle before a session starts', () => {
    expect(
      deriveChannelHealth({ sessionActive: false, capturing: false }).state,
    ).toBe('idle');
  });

  it('reports a channel that never started as unavailable', () => {
    const health = deriveChannelHealth({ sessionActive: true, capturing: false });
    expect(health.state).toBe('unavailable');
    expect(health.label).toBe('UNAVAILABLE');
  });

  it('never reads as live while sent audio and RMS are both zero', () => {
    const health = deriveChannelHealth({
      ...base,
      sentAudioMs: 0,
      rms: 0,
      msSinceStart: CAPTURE_GRACE_MS + 1,
    });
    expect(health.state).toBe('silent');
    expect(health.label).toBe('NO AUDIO');
  });

  it('waits out a grace period before calling a quiet channel silent', () => {
    expect(
      deriveChannelHealth({ ...base, msSinceStart: CAPTURE_GRACE_MS - 1 }).state,
    ).toBe('waiting');
  });

  it('is live once audio has demonstrably been sent', () => {
    expect(
      deriveChannelHealth({
        ...base,
        sentAudioMs: 120,
        rms: 0,
        msSinceStart: CAPTURE_GRACE_MS + 5000,
      }).state,
    ).toBe('live');
  });

  it('is live on audible signal even before the first transport metric', () => {
    expect(
      deriveChannelHealth({ ...base, rms: AUDIBLE_RMS * 4, msSinceStart: 500 })
        .state,
    ).toBe('live');
  });

  it('treats a level below the audible floor as no signal', () => {
    expect(
      deriveChannelHealth({
        ...base,
        rms: AUDIBLE_RMS / 2,
        msSinceStart: CAPTURE_GRACE_MS + 1,
      }).state,
    ).toBe('silent');
  });

  it('explains every non-live state', () => {
    for (const health of [
      deriveChannelHealth({ sessionActive: true, capturing: false }),
      deriveChannelHealth({ ...base, msSinceStart: 0 }),
      deriveChannelHealth({ ...base, msSinceStart: CAPTURE_GRACE_MS + 1 }),
    ]) {
      expect(health.detail).toBeTruthy();
    }
  });
});
