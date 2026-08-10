const assert = require('node:assert/strict');
const path = require('node:path');

const {
  LlamaTranslationServer,
} = require('../../../electron/captions/llama-translation-client');


async function main() {
  const binaryPath = process.env.TWINSCRIPT_LLAMA_SERVER;
  const modelPath = process.env.TWINSCRIPT_HYMT2_MODEL;
  if (!binaryPath || !modelPath) {
    console.log('SKIP: TWINSCRIPT_LLAMA_SERVER and TWINSCRIPT_HYMT2_MODEL are required');
    return;
  }
  const server = new LlamaTranslationServer({
    binaryPath: path.resolve(binaryPath),
    modelPath: path.resolve(modelPath),
  });
  try {
    await server.start();
    const cases = [
      ['English', 'Chinese', 'Set the supply to 24 VDC.', '24 VDC'],
      ['Chinese', 'English', '公差必须保持在 ±0.2 mm。', '0.2 mm'],
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
      assert.equal(result.actualDevice, 'CPU');
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
