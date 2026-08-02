const fs = require('fs');
const path = require('path');
const { EncryptedAudioWriter } = require('./encrypted-audio-writer');
const {
  appendTranscriptRecord,
  createSessionDirectory,
  finalizeTranscript,
  listSessions,
  readSessionManifest,
  resolveDefaultRecordsDirectory,
  updateSessionManifest,
  writeSessionManifest,
} = require('./meeting-record-store');
const { RecordingKeyStore } = require('./recording-key-store');
const { finalizeSessionAudio } = require('./wav-finalizer');

// Coordinates one meeting's record: the crash-safe transcript log, the two
// encrypted temporary audio streams, and the post-meeting keep/discard
// decision. Every other W2a module is a focused, independently-testable piece
// of mechanism; this class is the only one that knows how they compose into
// "what happens when a session starts, runs, and stops".
//
// Channel basenames are shared between the encrypted `.bcr` staging files and
// the finalized `.wav` files: `microphone` and `meeting-audio` (never
// `system.bcr` / `system.wav`), matching the visible record layout.
const CHANNEL_BASENAME = Object.freeze({ microphone: 'microphone', system: 'meeting-audio' });

function isEnoent(error) {
  return error && error.code === 'ENOENT';
}

class MeetingRecordController {
  constructor({
    app,
    safeStorage,
    settingsStore,
    sampleRate = 24000,
    now = Date.now,
    logger = console,
  }) {
    this.app = app;
    this.settingsStore = settingsStore;
    this.sampleRate = sampleRate;
    this.now = now;
    this.logger = logger;
    this.keyStore = new RecordingKeyStore({ app, safeStorage });
    this.pendingAudioRoot = path.join(app.getPath('userData'), 'pending-meeting-audio');
    this.onBackupState = null;
    this.current = null;
  }

  // -- path helpers ----------------------------------------------------

  pendingDir(sessionId) {
    return path.join(this.pendingAudioRoot, sessionId);
  }

  pendingChunkPath(sessionId, channel) {
    return path.join(this.pendingDir(sessionId), `${CHANNEL_BASENAME[channel]}.bcr`);
  }

  pendingManifestPath(sessionId) {
    return path.join(this.pendingDir(sessionId), 'manifest.json');
  }

  readPendingManifest(sessionId) {
    try {
      return JSON.parse(fs.readFileSync(this.pendingManifestPath(sessionId), 'utf8'));
    } catch {
      return null;
    }
  }

  recordsRootDir() {
    const configured = this.settingsStore.get().meetingRecordsDirectory;
    return configured || resolveDefaultRecordsDirectory(this.app);
  }

  /** Locate a session's visible directory by ID once its pending manifest is gone. */
  findSessionById(sessionId) {
    return listSessions(this.recordsRootDir()).find(
      (entry) => entry.manifest.sessionId === sessionId,
    );
  }

  // -- session lifecycle -------------------------------------------------

  /**
   * Begin recording one session. Throws only when the transcript folder
   * itself cannot be created — that is meant to block a live session from
   * starting, since transcript auto-save is the default contract. A missing
   * or locked encryption key is not fatal: the transcript still records, only
   * the audio backup is skipped for that session.
   */
  async startSession({ sessionId, startedAt, settings }) {
    let sessionDir;
    try {
      sessionDir = createSessionDirectory(this.recordsRootDir(), startedAt);
    } catch (error) {
      const wrapped = new Error(`Meeting records folder is unavailable: ${error.message}`);
      wrapped.code = 'records_directory_unavailable';
      throw wrapped;
    }

    fs.mkdirSync(this.pendingDir(sessionId), { recursive: true });
    fs.writeFileSync(
      this.pendingManifestPath(sessionId),
      JSON.stringify(
        {
          version: 1,
          sessionId,
          sessionDir,
          startedAt,
          autoSaveTranscript: Boolean(settings.autoSaveTranscript),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    let key = null;
    try {
      key = await this.keyStore.getKey();
    } catch (error) {
      this.logger.warn(
        '[MeetingRecordController] Encrypted audio backup unavailable for this session:',
        error.message,
      );
    }

    const writers = {};
    if (key) {
      for (const channel of Object.keys(CHANNEL_BASENAME)) {
        writers[channel] = new EncryptedAudioWriter({
          filePath: this.pendingChunkPath(sessionId, channel),
          key,
          sessionId,
          channel,
          onState: (event) => this.onBackupState?.(event),
        });
      }
    }

    this.current = {
      sessionId,
      sessionDir,
      startedAt,
      writers,
      keyMissing: !key,
      captionCount: 0,
      transcriptWrites: Promise.resolve(),
      settingsSnapshot: {
        glossaryConfigurationId: settings.glossaryConfigurationId,
        primaryProfile: settings.primaryProfile,
      },
      keepAudioAutomatically: Boolean(settings.keepAudioAutomatically),
      autoSaveTranscript: Boolean(settings.autoSaveTranscript),
    };
    return { recording: true, sessionDir };
  }

  /** Tee one PCM chunk to this channel's encrypted backup. A no-op if backup is unavailable. */
  writeAudioChunk(channel, pcm, capturedAt, durationMs) {
    this.current?.writers[channel]?.write(pcm, capturedAt, durationMs);
  }

  /**
   * Append one finalized bilingual caption to the transcript log. Every
   * revision before the source utterance and its translations settled is
   * intentionally never seen here — the caller only invokes this once
   * per finalized, unsuppressed source entry.
   */
  appendFinalRecord(event) {
    const session = this.current;
    if (!session || !session.autoSaveTranscript) return;
    const record = {
      sessionId: session.sessionId,
      sequence: event.sequence,
      capturedAt: event.sourceStartedAt || event.firstTranscriptAt || this.now(),
      sourceChannel: event.sourceChannel,
      sourceLanguage: event.sourceLanguage,
      sourceText: event.sourceText,
      english: event.english?.text || '',
      chinese: event.chinese?.text || '',
      translationStatus: {
        english: event.english?.status || 'pending',
        chinese: event.chinese?.status || 'pending',
      },
    };
    session.captionCount += 1;
    session.transcriptWrites = session.transcriptWrites.then(() =>
      appendTranscriptRecord(session.sessionDir, record).catch((error) => {
        this.logger.error(
          '[MeetingRecordController] Failed to append a transcript record:',
          error,
        );
      }),
    );
  }

  /**
   * Flush both writers, finalize the transcript, and either apply the
   * automatic-keep setting or leave the session pending an operator decision.
   */
  async stopSession({ appVersion, estimatedCostUsd } = {}) {
    const session = this.current;
    this.current = null;
    if (!session) return { recording: false };

    await session.transcriptWrites;
    const channelStats = {};
    for (const [channel, writer] of Object.entries(session.writers)) {
      channelStats[channel] = await writer.finish();
    }
    const channelAvailability = {
      microphone: (channelStats.microphone?.chunkCount || 0) > 0,
      system: (channelStats.system?.chunkCount || 0) > 0,
    };
    const hasAnyAudio = channelAvailability.microphone || channelAvailability.system;

    const sessionMeta = {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      startedAtIso: new Date(session.startedAt).toISOString(),
      endedAt: this.now(),
      appVersion,
      glossaryConfigurationId: session.settingsSnapshot.glossaryConfigurationId,
      primaryProfile: session.settingsSnapshot.primaryProfile,
      estimatedCostUsd,
      channelAvailability,
      audioRetention: session.keyMissing || !hasAnyAudio ? 'unavailable' : 'pending',
    };
    const manifest = session.autoSaveTranscript
      ? finalizeTranscript(session.sessionDir, sessionMeta).session
      : writeSessionManifest(session.sessionDir, sessionMeta);

    let result = {
      recording: true,
      sessionId: session.sessionId,
      sessionDir: session.sessionDir,
      session: manifest,
    };

    if (manifest.audioRetention === 'unavailable') {
      await this.removePendingAudio(session.sessionId, { force: true });
    } else if (session.keepAudioAutomatically) {
      result = await this.keep(session.sessionId);
    }
    return result;
  }

  // -- keep / discard ------------------------------------------------------

  /**
   * Decrypt, finalize, and retain the temporary audio for `sessionId`.
   *
   * Idempotent: a repeated call after the decision is already terminal (or
   * after an app restart) returns that state rather than redoing work. A
   * per-channel failure keeps that channel's encrypted source in place for a
   * later retry instead of losing it; the successful channel is not blocked
   * by it.
   */
  async keep(sessionId) {
    const resolved = this.resolvePendingOrTerminal(sessionId);
    if (resolved.terminal) return resolved.terminal;
    const { manifest } = resolved;

    let key;
    try {
      key = await this.keyStore.getKey();
    } catch (error) {
      return {
        recording: true,
        sessionId,
        sessionDir: manifest.sessionDir,
        session: readSessionManifest(manifest.sessionDir),
        error: { code: 'key_unavailable', message: error.message },
      };
    }

    const results = await finalizeSessionAudio({
      channels: {
        microphone: { filePath: this.pendingChunkPath(sessionId, 'microphone') },
        system: { filePath: this.pendingChunkPath(sessionId, 'system') },
      },
      key,
      sampleRate: this.sampleRate,
      epochMs: manifest.startedAt,
      destDir: manifest.sessionDir,
    });

    const anyFailed = Object.values(results).some((result) => result.status === 'failed');
    const allFailed = Object.values(results).every((result) => result.status === 'failed');

    if (allFailed) {
      // Nothing could be produced this attempt; leave the decision pending so
      // the operator (or a later automatic retry) can try again against the
      // still-intact encrypted originals.
      return {
        recording: true,
        sessionId,
        sessionDir: manifest.sessionDir,
        session: readSessionManifest(manifest.sessionDir),
        error: { code: 'keep_failed', channels: results },
      };
    }

    const session = updateSessionManifest(manifest.sessionDir, {
      audioRetention: 'kept',
      audioTracks: results,
    });

    // Only the encrypted source for a channel that finalized successfully (or
    // was legitimately missing) is removed. A failed channel's `.bcr` is
    // retained so `keep()` can be called again to retry just that channel.
    for (const [channel, result] of Object.entries(results)) {
      if (result.status === 'failed') continue;
      await this.unlinkIfExists(this.pendingChunkPath(sessionId, channel));
    }
    if (!anyFailed) await this.removePendingAudio(sessionId, { force: true });

    return { recording: true, sessionId, sessionDir: manifest.sessionDir, session };
  }

  /**
   * Discard the temporary audio for `sessionId` without finalizing it.
   * Irreversible, and idempotent for the same reasons as `keep`.
   */
  async discard(sessionId) {
    const resolved = this.resolvePendingOrTerminal(sessionId);
    if (resolved.terminal) return resolved.terminal;
    const { manifest } = resolved;

    await this.removePendingAudio(sessionId, { force: true });
    const session = updateSessionManifest(manifest.sessionDir, {
      audioRetention: 'discarded',
      audioTracks: null,
    });
    return { recording: true, sessionId, sessionDir: manifest.sessionDir, session };
  }

  /**
   * Resolve `sessionId` to its pending manifest, or to the terminal result a
   * repeated keep/discard call should return without doing anything.
   */
  resolvePendingOrTerminal(sessionId) {
    const manifest = this.readPendingManifest(sessionId);
    if (manifest) {
      const existing = readSessionManifest(manifest.sessionDir);
      if (existing && existing.audioRetention !== 'pending') {
        return {
          terminal: {
            recording: true,
            sessionId,
            sessionDir: manifest.sessionDir,
            session: existing,
          },
        };
      }
      return { manifest };
    }
    const found = this.findSessionById(sessionId);
    if (found) {
      return {
        terminal: {
          recording: true,
          sessionId,
          sessionDir: found.sessionDir,
          session: found.manifest,
        },
      };
    }
    return { terminal: { recording: false } };
  }

  async unlinkIfExists(filePath) {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  /** Remove a session's pending encrypted audio and its manifest. */
  async removePendingAudio(sessionId, { force = false } = {}) {
    const dir = this.pendingDir(sessionId);
    if (!force) {
      const remaining = await fs.promises
        .readdir(dir)
        .catch((error) => (isEnoent(error) ? [] : Promise.reject(error)));
      if (remaining.length > 1) return; // more than just manifest.json left
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  // -- crash recovery --------------------------------------------------

  /**
   * Finalize any session whose main process never called `stopSession` (a
   * crash or forced quit), and report sessions still awaiting a keep/discard
   * decision. Call once at app startup, before a new session can begin.
   */
  async recoverPendingSessions({ appVersion } = {}) {
    if (!fs.existsSync(this.pendingAudioRoot)) return [];
    const pending = [];
    for (const entry of fs.readdirSync(this.pendingAudioRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionId = entry.name;
      const manifest = this.readPendingManifest(sessionId);
      if (!manifest) continue; // no way to safely locate the visible directory

      let session = readSessionManifest(manifest.sessionDir);
      if (!session) {
        const channelAvailability = {
          microphone: fs.existsSync(this.pendingChunkPath(sessionId, 'microphone')),
          system: fs.existsSync(this.pendingChunkPath(sessionId, 'system')),
        };
        const hasAnyAudio = channelAvailability.microphone || channelAvailability.system;
        const sessionMeta = {
          sessionId,
          startedAt: manifest.startedAt,
          startedAtIso: new Date(manifest.startedAt).toISOString(),
          endedAt: this.now(),
          appVersion,
          channelAvailability,
          audioRetention: hasAnyAudio ? 'pending' : 'unavailable',
        };
        session =
          manifest.autoSaveTranscript === false
            ? writeSessionManifest(manifest.sessionDir, sessionMeta)
            : finalizeTranscript(manifest.sessionDir, sessionMeta).session;
      }

      if (session.audioRetention === 'pending') {
        pending.push({ sessionId, sessionDir: manifest.sessionDir, session });
      } else if (session.audioRetention === 'unavailable') {
        await this.removePendingAudio(sessionId, { force: true });
      }
    }
    return pending;
  }

  destroy() {
    this.keyStore.destroy();
  }
}

module.exports = { MeetingRecordController, CHANNEL_BASENAME };
