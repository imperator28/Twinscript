const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LocalInferenceSupervisor,
} = require('../electron/captions/local-inference-supervisor');


async function main() {
  const required = [
    'TWINSCRIPT_LOCAL_HOST',
    'TWINSCRIPT_WHISPER_MODEL',
    'TWINSCRIPT_WHISPER_PCM24',
    'TWINSCRIPT_LLAMA_SERVER',
    'TWINSCRIPT_HYMT2_MODEL',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.log(`SKIP: missing ${missing.join(', ')}`);
    return;
  }
  const supervisor = new LocalInferenceSupervisor({
    executablePath: path.resolve(process.env.TWINSCRIPT_LOCAL_HOST),
    whisperModelPath: path.resolve(process.env.TWINSCRIPT_WHISPER_MODEL),
    whisperDevice: 'NPU',
    cachePath: path.resolve(process.env.TWINSCRIPT_LOCAL_CACHE || '.local-inference-cache'),
    llamaBinaryPath: path.resolve(process.env.TWINSCRIPT_LLAMA_SERVER),
    hyMt2ModelPath: path.resolve(process.env.TWINSCRIPT_HYMT2_MODEL),
  });
  supervisor.on('diagnostic', (event) => console.error(JSON.stringify(event)));
  try {
    const ready = await supervisor.prepare(
      ['whisper-small', 'hy-mt2-1.8b'],
      'native-app-smoke',
    );
    assert.equal(ready.models.some((model) => model.actualDevice === 'NPU'), true);
    assert.equal(ready.models.some((model) => model.actualDevice === 'CPU'), true);
    const client = supervisor.client();
    await client.request('asr.start', {
      sessionId: 'native-app-smoke',
      channel: 'microphone',
    });
    const pcm = fs.readFileSync(process.env.TWINSCRIPT_WHISPER_PCM24);
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
      sessionId: 'native-app-smoke',
      channel: 'microphone',
      encoding: 'pcm_s16le',
      sampleRate: 24000,
      capturedAt: Date.now(),
      audio: Buffer.alloc(6000 * 2).toString('base64'),
    });
    assert.equal(preRoll.accepted, true);
    const partialTranscript = await client.request('asr.audio', {
      sessionId: 'native-app-smoke',
      channel: 'microphone',
      encoding: 'pcm_s16le',
      sampleRate: 24000,
      capturedAt: Date.now(),
      audio: quietPcm.toString('base64'),
    });
    const transcript = await client.request('asr.audio', {
      sessionId: 'native-app-smoke',
      channel: 'microphone',
      encoding: 'pcm_s16le',
      sampleRate: 24000,
      capturedAt: Date.now(),
      audio: Buffer.alloc(12000 * 2).toString('base64'),
    });
    assert.equal(partialTranscript.final, false);
    assert.ok(partialTranscript.audioDurationMs >= 2700, 'leading pre-roll must be retained');
    assert.match(transcript.text, /How are you doing today/i);
    assert.equal(transcript.final, true);
    assert.equal(transcript.actualDevice, 'NPU');

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
    assert.equal(translation.actualDevice, 'CPU');
    console.log(JSON.stringify({
      ready,
      whisperInputRms: { source: sourceRms, validated: quietTargetRms },
      partialTranscript,
      transcript,
      translation,
    }, null, 2));
  } finally {
    await supervisor.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
