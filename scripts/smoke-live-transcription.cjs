const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  LiveTranscriptionSession,
} = require('../electron/captions/live-transcription-session');
const { parseDevelopmentKey } = require('../electron/captions/credential-store');

function synthesizePcm(directory, name, voice, text) {
  const aiffPath = path.join(directory, `${name}.aiff`);
  const spoken = spawnSync('/usr/bin/say', ['-v', voice, '-o', aiffPath, text], {
    encoding: 'utf8',
  });
  if (spoken.status !== 0) {
    throw new Error(spoken.stderr || `Could not synthesize ${name}`);
  }
  const converted = spawnSync(
    '/opt/homebrew/bin/ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      aiffPath,
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      '24000',
      'pipe:1',
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (converted.status !== 0) {
    throw new Error(converted.stderr.toString() || `Could not convert ${name}`);
  }
  return new Int16Array(
    converted.stdout.buffer,
    converted.stdout.byteOffset,
    converted.stdout.byteLength / 2,
  );
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function streamInRealtime(session, samples) {
  const chunkSamples = 2400;
  for (let offset = 0; offset < samples.length; offset += chunkSamples) {
    session.appendAudio(samples.subarray(offset, offset + chunkSamples));
    await delay(100);
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('This smoke test currently uses the macOS say command');
  }
  const key = parseDevelopmentKey(
    fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8'),
  );
  if (!key) throw new Error('OPENAI_API_KEY is missing from .env.local');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-smoke-'));
  const transcripts = [];
  let session;
  try {
    const english = synthesizePcm(
      directory,
      'english',
      'Samantha',
      'The bracket tolerance is plus or minus zero point two millimeters.',
    );
    const chinese = synthesizePcm(
      directory,
      'chinese',
      'Tingting',
      '这个支架的公差是正负零点二毫米。',
    );
    session = new LiveTranscriptionSession({
      channel: 'microphone',
      apiKey: key,
      settings: {
        vadEnabled: false,
        vadThreshold: 0.012,
        delayProfile: 'low',
      },
      keywords: ['bracket', 'tolerance', '±0.2 mm', '支架', '公差'],
      onEvent: (event) => {
        if (event.type === 'transcript' && event.final) {
          transcripts.push(event.transcript);
          console.log(`TRANSCRIPT ${transcripts.length}: ${event.transcript}`);
        }
        if (event.type === 'error') {
          console.error(`PROVIDER ERROR: ${event.code}: ${event.message}`);
        }
      },
    });
    await session.connect();
    console.log('SESSION ACCEPTED');
    await streamInRealtime(session, english);
    await streamInRealtime(session, new Int16Array(24000));
    await streamInRealtime(session, chinese);
    await streamInRealtime(session, new Int16Array(30000));

    const deadline = Date.now() + 15000;
    while (transcripts.length < 2 && Date.now() < deadline) await delay(200);
    if (transcripts.length < 2) {
      throw new Error(`Expected 2 final transcripts, received ${transcripts.length}`);
    }
  } finally {
    session?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
