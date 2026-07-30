const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
  settingsVersion: 3,
  layout: 'stacked',
  primaryProfile: 'economy',
  shadowProfile: 'tiered',
  shadowEnabled: true,
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
      if (!parsed.settingsVersion || parsed.settingsVersion < 2) {
        // Phase 1 originally enabled a local RMS gate. It can discard quiet
        // microphones before a transcription turn is committed, so existing
        // installs migrate to the quieter-speech segmentation profile.
        next.vadEnabled = false;
      }
      if (!parsed.settingsVersion || parsed.settingsVersion < 3) {
        next.captionPaceMs = DEFAULT_SETTINGS.captionPaceMs;
      }
      next.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
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
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return next;
  }
}

module.exports = { DEFAULT_SETTINGS, SettingsStore };
