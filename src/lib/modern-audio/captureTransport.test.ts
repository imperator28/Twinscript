import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards for the failure that produced gibberish captions repeatedly.
 *
 * The chain was: the AudioWorklet is loaded from a URL string, so no import
 * crawler or bundler sees it → the file was deleted as unreachable → `addModule`
 * threw → the throw was caught and degraded to the ScriptProcessor fallback →
 * the fallback did not resample → 48 kHz audio went into a session declared as
 * 24 kHz → OpenAI decoded it at half rate and returned confident nonsense.
 *
 * Every link is cheap to assert and none of them was.
 */

const HERE = __dirname;
const RECORDER = join(HERE, 'BaseAudioRecorder.ts');

describe('the audio worklet asset', () => {
  it('exists at the path the recorder loads it from', () => {
    // Extracted from the source rather than hardcoded, so moving the worklet and
    // forgetting to move the file is caught, and so is the reverse.
    const source = readFileSync(RECORDER, 'utf8');
    const match = source.match(
      /new URL\(\s*'([^']+)'\s*,\s*import\.meta\.url\s*\)/,
    );
    expect(match, 'BaseAudioRecorder no longer builds a worklet URL').toBeTruthy();
    const specifier = match![1];
    const resolved = resolve(dirname(RECORDER), specifier);
    expect(
      existsSync(resolved),
      `${specifier} is referenced by getAudioWorkletProcessorUrl but does not exist`,
    ).toBe(true);
  });

  it('lives beside the recorder, not somewhere a cleanup can orphan it', () => {
    // It used to sit in src/services/worklets/, which had no other live file in
    // it. Colocation is the structural half of the fix.
    expect(existsSync(join(HERE, 'worklets', 'audio-recorder-worklet-processor.js'))).toBe(
      true,
    );
  });

  it('registers the processor name the recorder constructs', () => {
    const worklet = readFileSync(
      join(HERE, 'worklets', 'audio-recorder-worklet-processor.js'),
      'utf8',
    );
    const source = readFileSync(RECORDER, 'utf8');
    // A name mismatch fails exactly like a missing file: addModule succeeds and
    // the AudioWorkletNode constructor throws into the same catch.
    expect(worklet).toContain("registerProcessor('audio-recorder-processor'");
    expect(source).toContain("'audio-recorder-processor'");
  });
});

describe('resampleForTransport', () => {
  // Exercised through a minimal stand-in rather than a real AudioContext: the
  // method only reads `audioContext.sampleRate` and `sampleRate`.
  class Harness {
    audioContext: { sampleRate: number } | null;
    sampleRate: number;
    constructor(contextRate: number | null, targetRate: number) {
      this.audioContext = contextRate === null ? null : { sampleRate: contextRate };
      this.sampleRate = targetRate;
    }
  }
  async function resampler() {
    const source = readFileSync(RECORDER, 'utf8');
    const start = source.indexOf('protected resampleForTransport');
    expect(start, 'resampleForTransport is gone').toBeGreaterThan(-1);
    // Lift the method body out of the class so it can be called on the harness.
    const body = source.slice(start).replace('protected resampleForTransport', 'function fn');
    // Balance braces to find the end of the function.
    let depth = 0;
    let end = -1;
    for (let i = body.indexOf('{'); i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const source_fn = body
      .slice(0, end)
      .replace(/: Int16Array/g, '')
      .replace(/\bconst\s+(\w+):\s*\w+/g, 'const $1');
    // eslint-disable-next-line no-new-func
    return new Function(`${source_fn}; return fn;`)() as (
      this: Harness,
      input: Int16Array,
    ) => Int16Array;
  }

  it('halves 48 kHz capture for a 24 kHz session', async () => {
    const fn = await resampler();
    const input = new Int16Array(480);
    for (let i = 0; i < input.length; i += 1) input[i] = i % 100;
    const out = fn.call(new Harness(48000, 24000) as never, input);
    // The rate contract, which is what the API decodes against.
    expect(out.length).toBe(240);
  });

  it('leaves audio alone when the context already runs at the target rate', async () => {
    const fn = await resampler();
    const input = new Int16Array([1, 2, 3, 4]);
    const out = fn.call(new Harness(24000, 24000) as never, input);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it('does not invent samples when the context is slower than the target', async () => {
    const fn = await resampler();
    const input = new Int16Array([5, 6]);
    const out = fn.call(new Harness(16000, 24000) as never, input);
    expect(Array.from(out)).toEqual([5, 6]);
  });

  it('averages rather than dropping every other sample', async () => {
    const fn = await resampler();
    // Point decimation would return [0, 0]; averaging returns the midpoints.
    const input = new Int16Array([0, 100, 0, 100]);
    const out = fn.call(new Harness(48000, 24000) as never, input);
    expect(Array.from(out)).toEqual([50, 50]);
  });
});
