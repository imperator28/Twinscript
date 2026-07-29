import { LoopbackRecorder } from '../lib/modern-audio/LoopbackRecorder';
import { ModernAudioRecorder } from '../lib/modern-audio/ModernAudioRecorder';

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
  const needsPermission = devices.some(
    (device) => device.kind === 'audioinput' && !device.label,
  );
  if (needsPermission && requestPermission) {
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

export class AudioCaptureController {
  private microphone: ModernAudioRecorder | null = null;
  private system: LoopbackRecorder | null = null;
  private microphoneBatcher: PcmBatcher;
  private systemBatcher: PcmBatcher;

  constructor(
    send: (channel: Channel, samples: Int16Array) => void =
      (channel, samples) => window.captions.sendAudio(channel, samples),
  ) {
    this.microphoneBatcher = new PcmBatcher('microphone', send);
    this.systemBatcher = new PcmBatcher('system', send);
  }

  async start(microphoneDeviceId?: string) {
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

    this.system = new LoopbackRecorder(24000);
    const systemReady = await this.system.begin();
    if (!systemReady) {
      await this.stop();
      throw new Error(
        'Could not capture system audio. Check Screen Recording permission.',
      );
    }
    await this.system.record((data) => this.systemBatcher.push(data.mono));
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
