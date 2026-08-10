const childProcess = require('child_process');
const net = require('net');
const path = require('path');


function llamaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

class LlamaTranslationServer {
  constructor({
    binaryPath,
    modelPath,
    spawn = childProcess.spawn,
    fetchImpl = globalThis.fetch,
    allocatePort = allocateLoopbackPort,
    startupTimeoutMs = 120_000,
    requestTimeoutMs = 30_000,
  }) {
    this.binaryPath = binaryPath;
    this.modelPath = modelPath;
    this.spawnImpl = spawn;
    this.fetchImpl = fetchImpl;
    this.allocatePort = allocatePort;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.port = 0;
    this.started = false;
    this.startPromise = null;
    this.stderr = '';
    this.loadMs = 0;
  }

  async start() {
    if (this.started) return this.health();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    const startedAt = performance.now();
    this.port = await this.allocatePort();
    const args = [
      '-m', this.modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--no-webui', '-c', '2048',
      '--log-colors', 'off',
      '--gpu-layers', '0',
    ];
    const child = this.spawnImpl(this.binaryPath, args, {
      cwd: path.dirname(this.binaryPath),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    let spawnError = null;
    child.once?.('error', (error) => { spawnError = error; });
    child.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-8_000);
    });
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) {
        throw llamaError('local_translation_spawn_failed', spawnError.message);
      }
      if (child.exitCode != null) {
        throw llamaError(
          'local_translation_host_closed',
          `llama.cpp exited with code ${child.exitCode}: ${this.stderr.slice(-2_000)}`,
        );
      }
      try {
        const response = await this.fetchImpl(
          `http://127.0.0.1:${this.port}/health`,
          { signal: AbortSignal.timeout(2_000) },
        );
        if (response.ok) {
          this.started = true;
          this.loadMs = performance.now() - startedAt;
          return this.health();
        }
        if (response.status !== 503) {
          throw llamaError('local_translation_health_failed', `llama.cpp health returned ${response.status}`);
        }
      } catch (error) {
        if (error.code === 'local_translation_health_failed') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await this.stop();
    throw llamaError(
      'local_translation_start_timeout',
      `llama.cpp did not become ready: ${this.stderr.slice(-2_000)}`,
    );
  }

  health() {
    return {
      id: 'hy-mt2-1.8b',
      runtime: 'llama.cpp-b9940',
      requestedDevice: 'CPU',
      actualDevice: 'CPU',
      ready: this.started,
      loadMs: this.loadMs,
    };
  }

  async translate(type, payload, { signal } = {}) {
    if (!this.started) await this.start();
    let sourceText = String(payload.text || '');
    const protectedSpans = [];
    for (const token of payload.protectedTokens || []) {
      const literal = String(token || '').trim();
      if (!literal || !sourceText.includes(literal)) continue;
      const marker = `⟦TS${protectedSpans.length}⟧`;
      sourceText = sourceText.split(literal).join(marker);
      protectedSpans.push({ marker, literal });
    }
    const constraints = [];
    if (payload.glossary?.length) {
      constraints.push(
        `Use this terminology: ${payload.glossary.slice(0, 16).map((row) =>
          `${row.en || ''} = ${row.zh || ''}${row.doNotTranslate ? ' [keep verbatim]' : ''}`
        ).join('; ')}.`,
      );
    }
    const prompt =
      `Translate the following text into ${payload.targetLanguage}. ` +
      `${constraints.length ? `${constraints.join(' ')} ` : ''}` +
      'Note that you should only output the translated result without any additional explanation: ' +
      sourceText;
    const startedAt = performance.now();
    const requestController = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => requestController.abort(signal?.reason);
    if (signal?.aborted) requestController.abort(signal.reason);
    else signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      requestController.abort();
    }, this.requestTimeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetchImpl(
        `http://127.0.0.1:${this.port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_tokens: 256,
          }),
          signal: requestController.signal,
        },
      );
    } catch (error) {
      if (timedOut) {
        throw llamaError('local_translation_timeout', 'Local Hy-MT2 translation timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
    if (!response.ok) {
      throw llamaError('local_translation_failed', `llama.cpp returned HTTP ${response.status}`);
    }
    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw llamaError('local_translation_invalid_result', 'llama.cpp returned no translation');
    }
    let translatedText = text.trim();
    for (const { marker, literal } of protectedSpans) {
      translatedText = translatedText.split(marker).join(literal);
    }
    return {
      protocolVersion: 1,
      type: 'translate.result',
      utteranceId: payload.utteranceId,
      sourceRevision: payload.sourceRevision,
      sourceLanguage: payload.sourceLanguage,
      text: translatedText,
      authoritative: type === 'translate.final',
      model: 'hy-mt2-1.8b-q4-k-m',
      runtime: 'llama.cpp-b9940',
      requestedDevice: 'CPU',
      actualDevice: 'CPU',
      inferenceMs: performance.now() - startedAt,
      inputTokens: Number(body.usage?.prompt_tokens || 0),
      completionTokens: Number(body.usage?.completion_tokens || 0),
    };
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.started = false;
    if (child?.exitCode == null) child.kill();
  }
}

module.exports = { LlamaTranslationServer, allocateLoopbackPort };
