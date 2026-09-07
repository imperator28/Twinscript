import { afterEach, describe, expect, it, vi } from 'vitest';
import { enumerateAudioDevices } from './audioCapture';

/**
 * Device enumeration, guarded because getting it wrong is invisible.
 *
 * A wrong filter here does not throw and does not fail a build. It just quietly
 * leaves a microphone out of a dropdown, and the operator concludes the app
 * cannot see their hardware.
 */

type Device = {
  kind: MediaDeviceKind;
  deviceId: string;
  groupId: string;
  label: string;
};

function withDevices(devices: Device[]) {
  const getUserMedia = vi.fn().mockResolvedValue({
    getTracks: () => [{ stop: vi.fn() }],
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(devices),
        getUserMedia,
      },
    },
  });
  return { getUserMedia };
}

afterEach(() => vi.restoreAllMocks());

describe('enumerateAudioDevices', () => {
  it('keeps distinct microphones that share a groupId', async () => {
    // The real-world case this test exists for. Windows reported one groupId
    // across several capture endpoints of the same adapter, and deduping by it
    // left only the system default - so a machine with a working microphone array
    // and a virtual cable offered nothing but the cable.
    withDevices([
      { kind: 'audioinput', deviceId: 'cable', groupId: 'shared', label: 'CABLE Output (VB-Audio Virtual Cable)' },
      { kind: 'audioinput', deviceId: 'array', groupId: 'shared', label: 'Microphone Array (Intel Smart Sound)' },
    ]);
    const { inputs } = await enumerateAudioDevices();
    expect(inputs.map((d) => d.label)).toEqual([
      'CABLE Output (VB-Audio Virtual Cable)',
      'Microphone Array (Intel Smart Sound)',
    ]);
  });

  it('still drops the default and communications aliases', async () => {
    // Chromium lists these as duplicates of a real endpoint under reserved ids;
    // showing them would offer the same microphone three times.
    withDevices([
      { kind: 'audioinput', deviceId: 'default', groupId: 'g1', label: 'Default - Microphone Array' },
      { kind: 'audioinput', deviceId: 'communications', groupId: 'g1', label: 'Communications - Microphone Array' },
      { kind: 'audioinput', deviceId: 'array', groupId: 'g1', label: 'Microphone Array' },
    ]);
    const { inputs } = await enumerateAudioDevices();
    expect(inputs.map((d) => d.deviceId)).toEqual(['array']);
  });

  it('drops a genuinely repeated deviceId', async () => {
    withDevices([
      { kind: 'audioinput', deviceId: 'array', groupId: 'g1', label: 'Microphone Array' },
      { kind: 'audioinput', deviceId: 'array', groupId: 'g2', label: 'Microphone Array' },
    ]);
    const { inputs } = await enumerateAudioDevices();
    expect(inputs).toHaveLength(1);
  });

  it('separates inputs from outputs', async () => {
    // The same headset appears as both, sharing a groupId. Both must survive.
    withDevices([
      { kind: 'audioinput', deviceId: 'hs-in', groupId: 'headset', label: 'Headset Microphone' },
      { kind: 'audiooutput', deviceId: 'hs-out', groupId: 'headset', label: 'Headset Earphone' },
    ]);
    const { inputs, outputs } = await enumerateAudioDevices();
    expect(inputs.map((d) => d.label)).toEqual(['Headset Microphone']);
    expect(outputs.map((d) => d.label)).toEqual(['Headset Earphone']);
  });

  it('names an unlabelled device rather than showing a blank row', async () => {
    withDevices([
      { kind: 'audioinput', deviceId: 'a', groupId: 'g', label: '' },
      { kind: 'audioinput', deviceId: 'b', groupId: 'g', label: '' },
    ]);
    const { inputs } = await enumerateAudioDevices();
    expect(inputs.map((d) => d.label)).toEqual(['Microphone 1', 'Microphone 2']);
  });

  it('asks for permission only when told to, then re-enumerates', async () => {
    // Labels are empty until permission is granted, so the retest path has to
    // enumerate again afterwards or it caches the blank names.
    const { getUserMedia } = withDevices([
      { kind: 'audioinput', deviceId: 'a', groupId: 'g', label: 'Microphone Array' },
    ]);
    await enumerateAudioDevices();
    expect(getUserMedia).not.toHaveBeenCalled();
    await enumerateAudioDevices(true);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalledTimes(3);
  });
});
