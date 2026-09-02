const assert = require('node:assert/strict');
const path = require('node:path');

const {
  CPU_RUNTIME,
  CUDA_RUNTIME,
  LlamaTranslationServer,
} = require('../../../electron/captions/llama-translation-client');


async function main() {
  const family = process.env.TWINSCRIPT_HYMT2_FAMILY || 'cpu';
  assert.match(family, /^(cpu|cuda)$/);
  const binaryPath = family === 'cuda'
    ? process.env.TWINSCRIPT_LLAMA_CUDA_SERVER
    : process.env.TWINSCRIPT_LLAMA_CPU_SERVER;
  const modelPath = process.env.TWINSCRIPT_HYMT2_MODEL;
  if (!binaryPath || !modelPath) {
    console.log(`SKIP: ${family === 'cuda' ? 'TWINSCRIPT_LLAMA_CUDA_SERVER' : 'TWINSCRIPT_LLAMA_CPU_SERVER'} and TWINSCRIPT_HYMT2_MODEL are required`);
    return;
  }
  const server = new LlamaTranslationServer({
    binaryPath: path.resolve(binaryPath),
    modelPath: path.resolve(modelPath),
    runtimeDescriptor: family === 'cuda' ? CUDA_RUNTIME : CPU_RUNTIME,
  });
  try {
    await server.start();
    const cases = [
      ['English', 'Chinese', 'Set the supply to 24 VDC.', '24 VDC'],
      ['Chinese', 'English', '公差必须保持在 ±0.2 mm。', '0.2 mm'],
      ['English', 'Chinese', 'Alice approved fixture A-17 for production.', 'A-17'],
      ['Chinese', 'English', '张伟会在 3:30 检查样机。', '3:30'],
      ['English', 'Chinese', '请 review the CAD file rev B before release.', 'CAD'],
      ['Chinese', 'English', 'Please 保留 API token ZX-42 不变。', 'ZX-42'],
    ];
    for (let index = 0; index < cases.length; ++index) {
      const [sourceLanguage, targetLanguage, text, protectedValue] = cases[index];
      const result = await server.translate('translate.final', {
        utteranceId: `smoke-${index}`,
        sourceRevision: 1,
        sourceLanguage,
        targetLanguage,
        text,
        protectedTokens: [protectedValue],
      });
      assert.equal(result.actualDevice, family === 'cuda' ? 'CUDA0' : 'CPU');
      assert.equal(result.authoritative, true);
      assert.match(result.text, new RegExp(protectedValue.replace('.', '\\.')));
      console.log(JSON.stringify(result));
    }
  } finally {
    await server.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
