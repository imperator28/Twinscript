const fs = require('fs');
const path = require('path');
const { loadManifest } = require('./local-model-manifest');

const CATALOG_ERROR = {
  code: 'local_catalog_unavailable',
  message: 'Local model downloads are unavailable in this build.',
};

const WHISPER_SMALL_REQUIRED_PATHS = [
  'added_tokens.json',
  'config.json',
  'generation_config.json',
  'merges.txt',
  'normalizer.json',
  'openvino_config.json',
  'openvino_decoder_model.bin',
  'openvino_decoder_model.xml',
  'openvino_detokenizer.bin',
  'openvino_detokenizer.xml',
  'openvino_encoder_model.bin',
  'openvino_encoder_model.xml',
  'openvino_tokenizer.bin',
  'openvino_tokenizer.xml',
  'preprocessor_config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
];

function unavailable(root) {
  return {
    available: false,
    localAdoptionAvailable: false,
    root,
    manifest: null,
    error: CATALOG_ERROR,
  };
}

function localOnlyFile(modelId, file) {
  return {
    path: file.path,
    // A local-only catalog never enables download. This syntactically valid URL
    // keeps the shared manifest shape intact without claiming a release exists.
    url: `https://local.invalid/${modelId}/${file.path}`,
    size: file.size,
    sha256: file.sha256,
  };
}

function developmentLocalModelCatalog({ appPath, fsImpl = fs }) {
  const root = path.join(appPath, 'native', 'local-inference-host', 'models');
  try {
    const exportResults = JSON.parse(fsImpl.readFileSync(path.join(root, 'export-results.json'), 'utf8'));
    const whisper = exportResults.models?.['whisper-small'];
    const hyMt2 = JSON.parse(fsImpl.readFileSync(
      path.join(appPath, 'artifacts', 'local-inference', 'hymt2-cpu.json'),
      'utf8',
    ));
    const whisperPaths = new Set(whisper?.files?.map((file) => file.path));
    if (whisper?.exported !== true ||
        !Array.isArray(whisper.files) || !whisper.files.length ||
        !WHISPER_SMALL_REQUIRED_PATHS.every((requiredPath) => whisperPaths.has(requiredPath)) ||
        !/^[a-f0-9]{40}$/i.test(whisper.resolvedRevision || '') ||
        hyMt2?.passed !== true ||
        typeof hyMt2?.modelFile !== 'string' ||
        !Number.isSafeInteger(hyMt2.modelBytes) ||
        !/^[a-f0-9]{64}$/i.test(hyMt2.modelSha256 || '') ||
        !/^[a-f0-9]{40}$/i.test(hyMt2.resolvedRevision || '')) {
      return unavailable(root);
    }
    const whisperFiles = whisper.files.map((file) => localOnlyFile('whisper-small', file));
    const hyMt2File = localOnlyFile('hy-mt2-1.8b', {
      path: hyMt2.modelFile,
      size: hyMt2.modelBytes,
      sha256: hyMt2.modelSha256,
    });
    const manifest = loadManifest({
      json: {
        schemaVersion: 1,
        runtimeVersion: 'development-local-artifacts-v1',
        models: [
          {
            id: 'whisper-small',
            version: `openvino-int8-${whisper.resolvedRevision.slice(0, 16)}`,
            displayName: 'Whisper Small',
            purpose: 'Speech recognition',
            license: 'MIT',
            source: 'openai/whisper-small OpenVINO INT8 export',
            expectedDevice: 'NPU',
            unpackedSize: whisperFiles.reduce((total, file) => total + file.size, 0),
            launchPath: '.',
            localOnly: true,
            files: whisperFiles,
          },
          {
            id: 'hy-mt2-1.8b',
            version: `q4-k-m-${hyMt2.resolvedRevision.slice(0, 16)}`,
            displayName: 'HY-MT2 1.8B',
            purpose: 'English and Chinese translation',
            license: 'Apache-2.0',
            source: 'tencent/Hy-MT2-1.8B-GGUF Q4_K_M',
            expectedDevice: 'CPU',
            unpackedSize: hyMt2File.size,
            launchPath: hyMt2File.path,
            localOnly: true,
            files: [hyMt2File],
          },
        ],
      },
      packaged: false,
    });
    return { available: true, localAdoptionAvailable: true, root, manifest, error: null };
  } catch {
    return unavailable(root);
  }
}

module.exports = { WHISPER_SMALL_REQUIRED_PATHS, developmentLocalModelCatalog };
