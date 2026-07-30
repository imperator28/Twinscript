const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
  settingsVersion: 4,
  layout: 'stacked',
  primaryProfile: 'economy',
  shadowProfile: 'tiered',
  shadowEnabled: false,
  fastPath: true,
  provisionalTranslation: true,
  vadEnabled: false,
  vadThreshold: 0.012,
  delayProfile: 'low',
  budgetUsd: 5,
  glossary: [],
  captionFontScale: 1,
  captionPaceMs: 1200,
  showSourceInControl: true,
  recordEvaluation: false,
  recordingRetentionDays: 7,
  reorderWindowMs: 400,
  duplicateWindowMs: 1400,
});

class SettingsStore {
  constructor(app) {
    this.filePath = path.join(app.getPath('userData'), 'caption-settings.json');
  }

  get() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const next = { ...DEFAULT_SETTINGS, ...parsed };
      let migrated = false;
      if (!parsed.settingsVersion || parsed.settingsVersion < 2) {
        // Phase 1 originally enabled a local RMS gate. It can discard quiet
        // microphones before a transcription turn is committed, so existing
        // installs migrate to the quieter-speech segmentation profile.
        next.vadEnabled = false;
        migrated = true;
      }
      if (!parsed.settingsVersion || parsed.settingsVersion < 3) {
        next.captionPaceMs = DEFAULT_SETTINGS.captionPaceMs;
        migrated = true;
      }
      if (!parsed.settingsVersion || parsed.settingsVersion < 4) {
        // Evaluation controls are no longer part of the meeting interface.
        // Disable their persisted side effects so hidden comparison spending
        // or recording cannot carry into normal sessions.
        next.shadowEnabled = false;
        next.recordEvaluation = false;
        migrated = true;
      }
      next.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
      if (migrated) this.write(next);
      return next;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  set(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    const cleanPatch = Object.fromEntries(
      Object.entries(patch || {}).filter(([key]) => allowed.includes(key)),
    );
    const next = { ...this.get(), ...cleanPatch };
    this.write(next);
    return next;
  }

  write(settings) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(settings, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

module.exports = { DEFAULT_SETTINGS, SettingsStore };
