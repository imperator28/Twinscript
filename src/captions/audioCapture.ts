import { LoopbackRecorder } from '../lib/modern-audio/LoopbackRecorder';
import { ModernAudioRecorder } from '../lib/modern-audio/ModernAudioRecorder';
import {
  type CapturePlatform,
  describeSystemCaptureFailure,
  detectCapturePlatform,
} from './captureHealth';

type Channel = 'microphone' | 'system';

class PcmBatcher {
  private chunks: Int16Array[] = [];
  private sampleCount = 0;
  private readonly targetSamples = 2400;

  constructor(
    private readonly channel: Channel,
    private readonly send: (channel: Channel, samples: Int16Array) => void,
  ) {}

  push(samples: Int16Array) {
    this.chunks.push(new Int16Array(samples));
    this.sampleCount += samples.length;
    if (this.sampleCount < this.targetSamples) return;

    const merged = new Int16Array(this.sampleCount);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.sampleCount = 0;
    this.send(this.channel, merged);
  }

  flush() {
    if (!this.sampleCount) return;
    const merged = new Int16Array(this.sampleCount);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.sampleCount = 0;
    this.send(this.channel, merged);
  }
}

export interface AudioDeviceOption {
  deviceId: string;
  label: string;
}

export async function enumerateAudioDevices(requestPermission = false): Promise<{
  inputs: AudioDeviceOption[];
  outputs: AudioDeviceOption[];
}> {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (requestPermission) {
    const warmup = await navigator.mediaDevices.getUserMedia({ audio: true });
    warmup.getTracks().forEach((track) => track.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  const unique = (kind: MediaDeviceKind) => {
    const seen = new Set<string>();
    return devices
      .filter((device) => device.kind === kind)
      .filter((device) => !['default', 'communications'].includes(device.deviceId))
      .filter((device) => {
        const key = device.groupId || device.deviceId;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((device, index) => ({
        deviceId: device.deviceId,
        label:
          device.label ||
          `${kind === 'audioinput' ? 'Microphone' : 'Output'} ${index + 1}`,
      }));
  };
  return {
    inputs: unique('audioinput'),
    outputs: unique('audiooutput'),
  };
}

export interface CapturePreviewResult {
  microphone: true;
  system: boolean;
  warning?: string;
}

/**
 * Meters both capture channels before a session starts.
 *
 * It used to meter only the microphone, while the panel showed a Meeting / system
 * row alongside it. That row could only ever read zero during a test, because the
 * system level is published by a running session — so a perfectly healthy loopback
 * looked broken, and cost real time chasing a capture bug that did not exist.
 *
 * The system preview drives the SAME LoopbackRecorder the session uses. Metering a
 * different path would leave the test able to pass while the real thing failed,
 * which is the mistake worth not repeating.
 */
export class MicrophonePreviewController {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private animationFrame = 0;
  private system: LoopbackRecorder | null = null;

  async start(
    microphoneDeviceId: string | undefined,
    onLevel: (level: number) => void,
    onSystemLevel?: (level: number) => void,
  ): Promise<CapturePreviewResult> {
    await this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: microphoneDeviceId
        ? { deviceId: { exact: microphoneDeviceId } }
        : true,
    });
    this.context = new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.72;
    this.source.connect(this.analyser);
    const samples = new Float32Array(this.analyser.fftSize);
    const measure = () => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      onLevel(Math.sqrt(sum / samples.length));
      this.animationFrame = requestAnimationFrame(measure);
    };
    measure();

    if (!onSystemLevel) return { microphone: true, system: false };

    // Loopback failure must not fail the microphone test, exactly as it must not
    // fail a session: the operator still learns their microphone works and is told
    // what is wrong with the meeting channel.
    try {
      this.system = new LoopbackRecorder(24000);
      const ready = await this.system.begin();
      if (!ready) throw new Error('System audio capture is unavailable');
      await this.system.record((data: { mono: Float32Array }) => {
        const mono = data.mono;
        let sum = 0;
        for (let index = 0; index < mono.length; index++) sum += mono[index] * mono[index];
        onSystemLevel(mono.length ? Math.sqrt(sum / mono.length) : 0);
      });
      return { microphone: true, system: true };
    } catch (error) {
      await this.system?.end().catch(() => undefined);
      this.system = null;
      onSystemLevel(0);
      return {
        microphone: true,
        system: false,
        // Same platform detection the session uses, so the advice matches:
        // Windows and macOS fail loopback for entirely different reasons.
        warning: describeSystemCaptureFailure({
          platform: detectCapturePlatform(),
          error,
        }),
      };
    }
  }

  async stop() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') {
      await this.context.close();
    }
    this.stream = null;
    this.context = null;
    this.source = null;
    this.analyser = null;
    // Released before a session starts, or the session's own LoopbackRecorder
    // would contend with this one for the same capture.
    await this.system?.end().catch(() => undefined);
    this.system = null;
  }
}

export interface AudioCaptureStartResult {
  microphone: true;
  system: boolean;
  warning?: string;
}

export class AudioCaptureController {
  private microphone: ModernAudioRecorder | null = null;
  private system: LoopbackRecorder | null = null;
  private microphoneBatcher: PcmBatcher;
  private systemBatcher: PcmBatcher;
  private readonly platform: CapturePlatform;

  constructor(
    send: (channel: Channel, samples: Int16Array) => void =
      (channel, samples) => window.captions.sendAudio(channel, samples),
    platform: CapturePlatform = detectCapturePlatform(),
  ) {
    this.microphoneBatcher = new PcmBatcher('microphone', send);
    this.systemBatcher = new PcmBatcher('system', send);
    this.platform = platform;
  }

  /** Which channels currently hold a live recorder. */
  capturing(): { microphone: boolean; system: boolean } {
    return {
      microphone: Boolean(this.microphone),
      system: Boolean(this.system),
    };
  }

  async start(microphoneDeviceId?: string): Promise<AudioCaptureStartResult> {
    if (this.microphone || this.system) await this.stop();

    this.microphone = new ModernAudioRecorder({
      sampleRate: 24000,
      enablePassthrough: false,
      performanceMode: 'minimal',
    });
    const microphoneReady = await this.microphone.begin(microphoneDeviceId);
    if (!microphoneReady) {
      this.microphone = null;
      throw new Error('Could not start the selected microphone');
    }
    await this.microphone.record((data) =>
      this.microphoneBatcher.push(data.mono),
    );

    // A degraded microphone transport is reported, not just logged. The
    // ScriptProcessor path is the one that used to send 48 kHz audio into a
    // 24 kHz session and produce gibberish captions; it now resamples correctly,
    // but it is still the compatibility path and the operator should know they
    // are on it rather than discovering it from the transcript.
    const transportWarning =
      this.microphone.getCaptureTransport() === 'script-processor'
        ? 'Microphone capture is using the compatibility path, not the audio worklet. Captions still work; restart the app if the transcript looks wrong.'
        : undefined;

    // Loopback failure must never take the microphone down with it: the local
    // speaker's captions keep flowing and the operator is told what to fix.
    try {
      this.system = new LoopbackRecorder(24000);
      const systemReady = await this.system.begin();
      if (!systemReady) throw new Error('System audio capture is unavailable');
      await this.system.record((data) => this.systemBatcher.push(data.mono));
    } catch (error) {
      await this.system?.end().catch(() => undefined);
      this.system = null;
      return {
        microphone: true,
        system: false,
        warning: [
          transportWarning,
          describeSystemCaptureFailure({ platform: this.platform, error }),
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    return { microphone: true, system: true, warning: transportWarning };
  }

  async stop() {
    this.microphoneBatcher.flush();
    this.systemBatcher.flush();
    await Promise.allSettled([
      this.microphone?.end(),
      this.system?.end(),
    ]);
    this.microphone = null;
    this.system = null;
  }
}
