const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LocalInferenceSupervisor,
} = require('../electron/captions/local-inference-supervisor');

function readPcm16Mono24(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WAVE') {
    return bytes;
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString('ascii');
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > bytes.length) throw new Error('Invalid WAV chunk length');
    if (id === 'fmt ') {
      format = {
        encoding: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      };
    }
    if (id === 'data') data = bytes.subarray(body, body + size);
    offset = body + size + (size % 2);
  }
  if (!format || format.encoding !== 1 || format.channels !== 1 ||
      format.sampleRate !== 24000 || format.bitsPerSample !== 16 || !data) {
    throw new Error('Whisper smoke WAV must be mono 24 kHz 16-bit PCM');
  }
  return data;
}

function supervisorOptionsFromEnvironment(env, pathImpl = path) {
  return {
    executablePath: pathImpl.resolve(env.TWINSCRIPT_LOCAL_HOST),
    whisperModelPath: env.TWINSCRIPT_WHISPER_MODEL
      ? pathImpl.resolve(env.TWINSCRIPT_WHISPER_MODEL)
      : null,
    whisperDevice: 'NPU',
    cachePath: pathImpl.resolve(env.TWINSCRIPT_LOCAL_CACHE || '.local-inference-cache'),
    llamaCpuBinaryPath: pathImpl.resolve(env.TWINSCRIPT_LLAMA_CPU_SERVER),
    llamaCudaBinaryPath: env.TWINSCRIPT_LLAMA_CUDA_SERVER
      ? pathImpl.resolve(env.TWINSCRIPT_LLAMA_CUDA_SERVER)
      : null,
    hyMt2ModelPath: pathImpl.resolve(env.TWINSCRIPT_HYMT2_MODEL),
    cudaEnabled: env.TWINSCRIPT_HYMT2_CUDA === '1',
  };
}

async function main() {
  const translationOnly = process.env.TWINSCRIPT_SMOKE_TRANSLATION_ONLY === '1';
  const required = [
    'TWINSCRIPT_LOCAL_HOST',
    'TWINSCRIPT_LLAMA_CPU_SERVER',
    'TWINSCRIPT_HYMT2_MODEL',
  ];
  if (!translationOnly) required.push('TWINSCRIPT_WHISPER_MODEL', 'TWINSCRIPT_WHISPER_PCM24');
  if (process.env.TWINSCRIPT_HYMT2_CUDA === '1') required.push('TWINSCRIPT_LLAMA_CUDA_SERVER');
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.log(`SKIP: missing ${missing.join(', ')}`);
    return;
  }
  const supervisor = new LocalInferenceSupervisor(supervisorOptionsFromEnvironment(process.env));
  supervisor.on('diagnostic', (event) => console.error(JSON.stringify(event)));
  try {
    const ready = await supervisor.prepare(
      translationOnly ? ['hy-mt2-1.8b'] : ['whisper-small', 'hy-mt2-1.8b'],
      'native-app-smoke',
    );
    const client = supervisor.client();
    let whisperEvidence = null;
    if (!translationOnly) {
      assert.equal(ready.models.some((model) => model.actualDevice === 'NPU'), true);
      await client.request('asr.start', {
        sessionId: 'native-app-smoke',
        channel: 'microphone',
      });
      const pcm = readPcm16Mono24(process.env.TWINSCRIPT_WHISPER_PCM24);
      const sourceSamples = new Int16Array(
        pcm.buffer,
        pcm.byteOffset,
        pcm.byteLength / Int16Array.BYTES_PER_ELEMENT,
      );
      const sourceRms = Math.sqrt(
        sourceSamples.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0) /
          sourceSamples.length,
      );
      const quietTargetRms = 0.003;
      const quietScale = Math.min(1, quietTargetRms / sourceRms);
      const quietPcm = Buffer.alloc(pcm.length);
      for (let index = 0; index < sourceSamples.length; ++index) {
        quietPcm.writeInt16LE(Math.round(sourceSamples[index] * quietScale), index * 2);
      }
      const preRoll = await client.request('asr.audio', {
        sessionId: 'native-app-smoke', channel: 'microphone', encoding: 'pcm_s16le',
        sampleRate: 24000, capturedAt: Date.now(), audio: Buffer.alloc(6000 * 2).toString('base64'),
      });
      assert.equal(preRoll.accepted, true);
      const partialTranscript = await client.request('asr.audio', {
        sessionId: 'native-app-smoke', channel: 'microphone', encoding: 'pcm_s16le',
        sampleRate: 24000, capturedAt: Date.now(), audio: quietPcm.toString('base64'),
      });
      const transcript = await client.request('asr.audio', {
        sessionId: 'native-app-smoke', channel: 'microphone', encoding: 'pcm_s16le',
        sampleRate: 24000, capturedAt: Date.now(), audio: Buffer.alloc(12000 * 2).toString('base64'),
      });
      assert.equal(partialTranscript.final, false);
      assert.ok(partialTranscript.audioDurationMs >= 2700, 'leading pre-roll must be retained');
      assert.match(transcript.text, /Ask not what your country can do for you/i);
      assert.equal(transcript.final, true);
      assert.equal(transcript.actualDevice, 'NPU');
      whisperEvidence = { sourceRms, validatedRms: quietTargetRms, partialTranscript, transcript };
    }

    const translation = await client.request('translate.final', {
      sessionId: 'native-app-smoke',
      utteranceId: 'smoke-translation',
      sourceRevision: 1,
      sourceLanguage: 'English',
      targetLanguage: 'Chinese',
      text: 'Set the supply to 24 VDC.',
      protectedTokens: ['24 VDC'],
    });
    assert.match(translation.text, /24 VDC/);
    assert.equal(translation.authoritative, true);
    if (process.env.TWINSCRIPT_HYMT2_CUDA === '1') {
      assert.equal(
        translation.actualDevice === 'CUDA0' ||
          (translation.actualDevice === 'CPU' && Boolean(translation.fallbackReason)),
        true,
        'CUDA mode must prove CUDA0 or an explicit local CPU fallback',
      );
    } else {
      assert.equal(translation.actualDevice, 'CPU');
    }
    console.log(JSON.stringify({
      ready,
      whisperEvidence,
      translation,
    }, null, 2));
  } finally {
    await supervisor.dispose();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main, readPcm16Mono24, supervisorOptionsFromEnvironment };
