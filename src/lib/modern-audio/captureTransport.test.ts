import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BaseAudioRecorder } from './BaseAudioRecorder';
import { ModernAudioRecorder } from './ModernAudioRecorder';

const HERE = __dirname;
const RECORDER = join(HERE, 'BaseAudioRecorder.ts');

class RecorderHarness extends BaseAudioRecorder {
  protected getLogPrefix(): string {
    return '[capture transport test]';
  }

  async wireScriptProcessor(context: AudioContext, source: MediaStreamAudioSourceNode) {
    this.audioContext = context;
    this.mediaStreamSource = source;
    await this.setupScriptProcessorFallback();
  }

  resample(input: Int16Array, sourceRate: number): Int16Array {
    this.audioContext = { sampleRate: sourceRate } as AudioContext;
    return this.resampleForTransport(input);
  }

  startCapturing(onPcm: (pcm: Int16Array) => void) {
    this.onAudioData = ({ mono }) => onPcm(mono);
    this.startRecording();
  }

  driveScriptProcessor(input: Float32Array) {
    this.scriptProcessor?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => input },
    } as unknown as AudioProcessingEvent);
  }
}

class ModernRecorderHarness extends ModernAudioRecorder {
  setMediaRecorderForTest(mediaRecorder: unknown) {
    (this as unknown as { mediaRecorder: unknown }).mediaRecorder = mediaRecorder;
  }

  primeFallbackPhase(input: Int16Array) {
    this.audioContext = { sampleRate: 48000 } as AudioContext;
    this.resampleForTransport(input);
  }

  emitFallback(input: Int16Array) {
    this._processAudioData(this.resampleForTransport(input));
  }
}

function makeFallbackGraph(sourceRate: number) {
  const scriptProcessor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null,
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1 },
  };
  const context = {
    sampleRate: sourceRate,
    createScriptProcessor: vi.fn(() => scriptProcessor),
    createGain: vi.fn(() => gain),
    destination: {},
  };
  return {
    context: context as unknown as AudioContext,
    source: source as unknown as MediaStreamAudioSourceNode,
    scriptProcessor,
  };
}

describe('the audio worklet asset', () => {
  it('exists at the path the recorder loads it from', () => {
    const source = readFileSync(RECORDER, 'utf8');
    const match = source.match(/new URL\(\s*'([^']+)'\s*,\s*import\.meta\.url\s*\)/);
    expect(match, 'BaseAudioRecorder no longer builds a worklet URL').toBeTruthy();
    const specifier = match![1];
    expect(existsSync(resolve(dirname(RECORDER), specifier))).toBe(true);
  });

  it('lives beside the recorder and registers the constructed processor name', () => {
    const worklet = readFileSync(
      join(HERE, 'worklets', 'audio-recorder-worklet-processor.js'),
      'utf8',
    );
    expect(existsSync(join(HERE, 'worklets', 'audio-recorder-worklet-processor.js'))).toBe(
      true,
    );
    expect(worklet).toContain("registerProcessor('audio-recorder-processor'");
  });
});

describe('ScriptProcessor transport resampling', () => {
  it('downsamples 48 kHz capture to the declared 24 kHz transport rate', () => {
    const recorder = new RecorderHarness(24000);

    const output = recorder.resample(new Int16Array([0, 100, 0, 100]), 48000);

    expect(Array.from(output)).toEqual([50, 50]);
  });

  it('upsamples sub-24 kHz capture instead of sending mislabeled PCM unchanged', () => {
    const recorder = new RecorderHarness(24000);

    const output = recorder.resample(new Int16Array([0, 100, 200]), 16000);

    expect(Array.from(output)).toEqual([0, 67, 133, 200]);
  });

  it('preserves fractional 44.1 kHz phase across callbacks', () => {
    const recorder = new RecorderHarness(24000);
    const firstInput = new Int16Array(441);
    const secondInput = new Int16Array(441);
    for (let index = 0; index < firstInput.length; index += 1) {
      firstInput[index] = index;
      secondInput[index] = index + firstInput.length;
    }

    const output = [
      ...recorder.resample(firstInput, 44100),
      ...recorder.resample(secondInput, 44100),
    ];

    expect(output).toHaveLength(480);
    expect(output).toEqual(
      Array.from({ length: 480 }, (_, index) =>
        Math.round(((index + 0.5) * 44100) / 24000 - 0.5),
      ),
    );
  });

  it('resets fractional state when a new recording starts', () => {
    const recorder = new RecorderHarness(24000);
    recorder.resample(new Int16Array([0, 0, 0]), 48000);

    recorder.startCapturing(() => {});
    const output = recorder.resample(new Int16Array([0, 100, 200, 300]), 48000);

    expect(Array.from(output)).toEqual([50, 250]);
  });

  it('wires ScriptProcessor callbacks through the declared-rate PCM transport', async () => {
    const recorder = new RecorderHarness(24000);
    const graph = makeFallbackGraph(48000);
    const emitted: Int16Array[] = [];

    await recorder.wireScriptProcessor(graph.context, graph.source);
    recorder.startCapturing((pcm) => emitted.push(pcm));
    recorder.driveScriptProcessor(new Float32Array(480).fill(0.5));

    expect(graph.scriptProcessor.onaudioprocess).toEqual(expect.any(Function));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toHaveLength(240);
    expect(Array.from(emitted[0])).toEqual(Array(240).fill(16383));
  });

  it('starts a fresh fallback timeline after pause and record', async () => {
    const recorder = new ModernRecorderHarness({ sampleRate: 24000 });
    const emitted: Int16Array[] = [];
    const mediaRecorder = {
      state: 'inactive' as 'inactive' | 'recording',
      start: vi.fn(() => {
        mediaRecorder.state = 'recording';
      }),
      stop: vi.fn(() => {
        mediaRecorder.state = 'inactive';
      }),
    };
    recorder.setMediaRecorderForTest(mediaRecorder);

    await recorder.record(({ mono }) => emitted.push(mono));
    await recorder.pause();
    // A queued fallback callback may arrive after pause. `record()` must not
    // let that stale phase influence the first resumed recording frame.
    recorder.primeFallbackPhase(new Int16Array([0, 0, 0]));

    await recorder.record(({ mono }) => emitted.push(mono));
    recorder.emitFallback(new Int16Array([0, 100, 200, 300]));

    expect(emitted).toHaveLength(1);
    expect(Array.from(emitted[0])).toEqual([50, 250]);
  });
});
