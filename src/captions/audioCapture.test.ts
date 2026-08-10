import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  microphone: {
    begin: vi.fn(),
    record: vi.fn(),
    end: vi.fn(),
    getCaptureTransport: vi.fn(),
  },
  system: {
    begin: vi.fn(),
    record: vi.fn(),
    end: vi.fn(),
  },
  describeSystemCaptureFailure: vi.fn(),
}));

vi.mock('../lib/modern-audio/ModernAudioRecorder', () => ({
  ModernAudioRecorder: class {
    begin = mocks.microphone.begin;
    record = mocks.microphone.record;
    end = mocks.microphone.end;
    getCaptureTransport = mocks.microphone.getCaptureTransport;
  },
}));

vi.mock('../lib/modern-audio/LoopbackRecorder', () => ({
  LoopbackRecorder: class {
    begin = mocks.system.begin;
    record = mocks.system.record;
    end = mocks.system.end;
  },
}));

vi.mock('./captureHealth', () => ({
  detectCapturePlatform: () => 'windows',
  describeSystemCaptureFailure: mocks.describeSystemCaptureFailure,
}));

import { AudioCaptureController } from './audioCapture';

const compatibilityWarning =
  'Microphone capture is using the compatibility path, not the audio worklet. Captions still work; restart the app if the transcript looks wrong.';

describe('AudioCaptureController transport warnings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.microphone.begin.mockResolvedValue(true);
    mocks.microphone.record.mockResolvedValue(true);
    mocks.microphone.end.mockResolvedValue(undefined);
    mocks.microphone.getCaptureTransport.mockReturnValue('script-processor');
    mocks.system.begin.mockResolvedValue(true);
    mocks.system.record.mockResolvedValue(true);
    mocks.system.end.mockResolvedValue(undefined);
    mocks.describeSystemCaptureFailure.mockReturnValue('System capture is unavailable.');
  });

  it('reports the compatibility warning when ScriptProcessor microphone capture starts with system capture', async () => {
    const result = await new AudioCaptureController(() => {}, 'windows').start();

    expect(result).toEqual({
      microphone: true,
      system: true,
      warning: compatibilityWarning,
    });
  });

  it('combines the compatibility warning with the system capture failure warning', async () => {
    mocks.system.begin.mockResolvedValue(false);

    const result = await new AudioCaptureController(() => {}, 'windows').start();

    expect(result).toEqual({
      microphone: true,
      system: false,
      warning: `${compatibilityWarning} System capture is unavailable.`,
    });
    expect(mocks.describeSystemCaptureFailure).toHaveBeenCalledWith({
      platform: 'windows',
      error: expect.any(Error),
    });
  });

  it('does not report a compatibility warning when AudioWorklet microphone capture starts', async () => {
    mocks.microphone.getCaptureTransport.mockReturnValue('audio-worklet');

    const result = await new AudioCaptureController(() => {}, 'windows').start();

    expect(result).toEqual({
      microphone: true,
      system: true,
      warning: undefined,
    });
  });
});
