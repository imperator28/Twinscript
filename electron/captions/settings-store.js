const fs = require('fs');
const path = require('path');
const {
  compileGlossarySelection,
} = require('./glossary-config');
const CAPTION_THEMES = require('../../shared/caption-themes.json');

const DEFAULT_GLOSSARY = compileGlossarySelection(
  'universal-engineering',
  null,
);

const MIN_CAPTION_HISTORY_ENTRIES = 3;
const MAX_CAPTION_HISTORY_ENTRIES = 10;
const DEFAULT_CAPTION_HISTORY_ENTRIES = 6;
const DEFAULT_CAPTION_THEME = 'blueprint';
const CAPTION_THEME_IDS = new Set(CAPTION_THEMES.map((theme) => theme.id));
const MIN_CAPTION_OVERLAY_HEIGHT = 64;
const MAX_CAPTION_OVERLAY_HEIGHT = 2000;

function clampHistoryEntries(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_CAPTION_HISTORY_ENTRIES;
  return Math.min(MAX_CAPTION_HISTORY_ENTRIES, Math.max(MIN_CAPTION_HISTORY_ENTRIES, number));
}

function normalizeCaptionTheme(value) {
  return CAPTION_THEME_IDS.has(value) ? value : DEFAULT_CAPTION_THEME;
}

function normalizeCaptionOverlayHeight(value) {
  if (value === null) return null;
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number < MIN_CAPTION_OVERLAY_HEIGHT ||
    number > MAX_CAPTION_OVERLAY_HEIGHT
  ) {
    return null;
  }
  return Math.round(number);
}

function normalizeOutputMode(value) {
  return value === 'virtual-camera' ? 'virtual-camera' : 'overlays';
}

function normalizeLayout(value) {
  return value === 'side-by-side' ? 'side-by-side' : 'stacked';
}

/**
 * The transcription API's accepted `delay` values.
 *
 * `'default'` shipped as the "Stable" dropdown option and is NOT one of them - the API
 * answers "Invalid value: 'default'. Supported values are: 'minimal', 'low', 'medium',
 * 'high', and 'xhigh'." The value was never validated here, so the only thing that ever
 * checked it was the server, at the moment a session tried to start. Any stored value
 * outside the set now falls back to the default rather than reaching the API.
 */
const DELAY_PROFILES = ['minimal', 'low', 'medium', 'high', 'xhigh'];

function normalizeDelayProfile(value) {
  return DELAY_PROFILES.includes(value) ? value : 'low';
}

/**
 * Meeting context notes: participant names, project and site names. Not translation
 * pairs - they tell the model who and what is being discussed so a supplier's name is
 * transcribed rather than guessed at phonetically.
 *
 * Bounded on both axes because these are interpolated into every request: a pasted
 * document would otherwise silently become the prompt.
 */
const CONTEXT_NOTE_LIMIT = 40;
const CONTEXT_NOTE_LENGTH = 120;

function normalizeContextNotes(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const notes = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().slice(0, CONTEXT_NOTE_LENGTH);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(trimmed);
    if (notes.length >= CONTEXT_NOTE_LIMIT) break;
  }
  return notes;
}

const DEFAULT_SETTINGS = Object.freeze({
  settingsVersion: 12,
  glossaryContextNotes: [],
  layout: 'stacked',
  outputMode: 'overlays',
  primaryProfile: 'economy',
  shadowProfile: 'tiered',
  shadowEnabled: false,
  fastPath: true,
  provisionalTranslation: true,
  vadEnabled: false,
  vadThreshold: 0.012,
  delayProfile: 'low',
  budgetUsd: 5,
  glossaryConfigurationId: DEFAULT_GLOSSARY.glossaryConfigurationId,
  customGlossaryConfiguration: null,
  glossary: DEFAULT_GLOSSARY.glossary,
  protectedTokens: DEFAULT_GLOSSARY.protectedTokens,
  glossaryStoredCount: DEFAULT_GLOSSARY.glossaryStoredCount,
  captionFontScale: 1,
  showSourceInControl: true,
  recordEvaluation: false,
  recordingRetentionDays: 7,
  reorderWindowMs: 400,
  duplicateWindowMs: 1400,
  // Meeting-record settings (W2a). Transcript auto-save is on by default —
  // it is part of the product's default contract, not an opt-in extra.
  // Encrypted temporary audio capture is always active during a live session;
  // `keepAudioAutomatically` only controls whether it is retained afterward
  // without asking, so it defaults to off.
  autoSaveTranscript: true,
  keepAudioAutomatically: false,
  meetingRecordsDirectory: null,
  captionHistoryEntries: DEFAULT_CAPTION_HISTORY_ENTRIES,
  captionTheme: DEFAULT_CAPTION_THEME,
  captionOverlayHeight: null,
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
      if (!parsed.settingsVersion || parsed.settingsVersion < 4) {
        // Evaluation controls are no longer part of the meeting interface.
        // Disable their persisted side effects so hidden comparison spending
        // or recording cannot carry into normal sessions.
        next.shadowEnabled = false;
        next.recordEvaluation = false;
        migrated = true;
      }
      if (!parsed.settingsVersion || parsed.settingsVersion < 5) {
        const legacyTerms = Array.isArray(parsed.glossary)
          ? parsed.glossary
          : [];
        const legacyCustom = legacyTerms.length
          ? {
              schemaVersion: 1,
              id: 'legacy-custom-glossary',
              name: 'Migrated custom glossary',
              description: 'Terms saved before meeting configurations were added.',
              regions: [],
              domains: [],
              protectedTokens: [],
              terms: legacyTerms,
            }
          : null;
        Object.assign(
          next,
          compileGlossarySelection(
            parsed.glossaryConfigurationId || 'universal-engineering',
            parsed.customGlossaryConfiguration || legacyCustom,
          ),
        );
        migrated = true;
      } else {
        Object.assign(
          next,
          compileGlossarySelection(
            next.glossaryConfigurationId,
            next.customGlossaryConfiguration,
          ),
        );
      }
      if (!parsed.settingsVersion || parsed.settingsVersion < 6) {
        next.autoSaveTranscript = DEFAULT_SETTINGS.autoSaveTranscript;
        next.keepAudioAutomatically = DEFAULT_SETTINGS.keepAudioAutomatically;
        next.meetingRecordsDirectory = DEFAULT_SETTINGS.meetingRecordsDirectory;
        next.captionHistoryEntries = DEFAULT_SETTINGS.captionHistoryEntries;
        migrated = true;
      } else {
        next.captionHistoryEntries = clampHistoryEntries(next.captionHistoryEntries);
      }
      if (!parsed.settingsVersion || parsed.settingsVersion < 7) {
        next.captionTheme = DEFAULT_SETTINGS.captionTheme;
        next.captionOverlayHeight = DEFAULT_SETTINGS.captionOverlayHeight;
        migrated = true;
      } else {
        const captionTheme = normalizeCaptionTheme(next.captionTheme);
        const captionOverlayHeight = normalizeCaptionOverlayHeight(
          next.captionOverlayHeight,
        );
        if (
          captionTheme !== next.captionTheme ||
          captionOverlayHeight !== next.captionOverlayHeight
        ) {
          migrated = true;
        }
        next.captionTheme = captionTheme;
        next.captionOverlayHeight = captionOverlayHeight;
      }
      if (!parsed.settingsVersion || parsed.settingsVersion < 8) {
        // W2 consolidates all engineering vocabulary into one built-in
        // glossary. compileGlossarySelection above preserves custom rows while
        // normalizing every legacy meeting-type ID to the universal catalog.
        migrated = true;
      }
      if (!parsed.settingsVersion || parsed.settingsVersion < 9) {
        next.outputMode = DEFAULT_SETTINGS.outputMode;
        migrated = true;
      } else {
        const outputMode = normalizeOutputMode(next.outputMode);
        if (outputMode !== next.outputMode) migrated = true;
        next.outputMode = outputMode;
      }
      if (!parsed.settingsVersion || parsed.settingsVersion < 10) {
        next.layout = normalizeLayout(next.layout);
        migrated = true;
      } else {
        const layout = normalizeLayout(next.layout);
        if (layout !== next.layout) migrated = true;
        next.layout = layout;
      }
      // v12 repairs an invalid delay profile. 'default' shipped as a selectable option
      // and the API rejects it, so an install that ever chose "Stable" could not start a
      // session at all until the value was changed by hand.
      {
        const delayProfile = normalizeDelayProfile(next.delayProfile);
        if (delayProfile !== next.delayProfile) migrated = true;
        next.delayProfile = delayProfile;
      }
      // v11 adds meeting context notes: names, projects and sites that inform
      // transcription without being translation pairs. Normalized on every read rather
      // than only on the version step, because these come from a free-text field.
      {
        const notes = normalizeContextNotes(next.glossaryContextNotes);
        if (
          !Array.isArray(next.glossaryContextNotes) ||
          notes.length !== next.glossaryContextNotes.length
        ) {
          migrated = true;
        }
        next.glossaryContextNotes = notes;
      }
      // W2 replaces delayed presentation with immediate, complete-entry
      // history. A legacy pace value is discarded rather than reinterpreted.
      delete next.captionPaceMs;
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
    if (
      Object.hasOwn(cleanPatch, 'glossaryConfigurationId') ||
      Object.hasOwn(cleanPatch, 'customGlossaryConfiguration')
    ) {
      Object.assign(
        next,
        compileGlossarySelection(
          next.glossaryConfigurationId,
          next.customGlossaryConfiguration,
        ),
      );
    }
    if (Object.hasOwn(cleanPatch, 'captionHistoryEntries')) {
      next.captionHistoryEntries = clampHistoryEntries(next.captionHistoryEntries);
    }
    if (Object.hasOwn(cleanPatch, 'captionTheme')) {
      next.captionTheme = normalizeCaptionTheme(next.captionTheme);
    }
    if (Object.hasOwn(cleanPatch, 'captionOverlayHeight')) {
      next.captionOverlayHeight = normalizeCaptionOverlayHeight(
        next.captionOverlayHeight,
      );
    }
    if (Object.hasOwn(cleanPatch, 'outputMode')) {
      next.outputMode = normalizeOutputMode(next.outputMode);
    }
    if (Object.hasOwn(cleanPatch, 'layout')) {
      next.layout = normalizeLayout(next.layout);
    }
    if (Object.hasOwn(cleanPatch, 'delayProfile')) {
      next.delayProfile = normalizeDelayProfile(next.delayProfile);
    }
    if (Object.hasOwn(cleanPatch, 'glossaryContextNotes')) {
      // Bounded here as well as on read: this arrives from a free-text field, and
      // whatever is stored is interpolated into every request.
      next.glossaryContextNotes = normalizeContextNotes(next.glossaryContextNotes);
    }
    this.write(next);
    return next;
  }

  /**
   * Restore every stored setting to its shipped default.
   *
   * Scoped to this file only. The API key lives in the OS credential store and saved
   * meetings live in the records directory, so neither is reachable from here - which is
   * the property that makes a "reset all" safe to offer at all.
   */
  reset() {
    const defaults = { ...DEFAULT_SETTINGS };
    this.write(defaults);
    return defaults;
  }

  write(settings) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(settings, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  SettingsStore,
  MIN_CAPTION_HISTORY_ENTRIES,
  MAX_CAPTION_HISTORY_ENTRIES,
  clampHistoryEntries,
  CAPTION_THEMES,
  DEFAULT_CAPTION_THEME,
  normalizeCaptionTheme,
  normalizeCaptionOverlayHeight,
  normalizeOutputMode,
  normalizeLayout,
};
