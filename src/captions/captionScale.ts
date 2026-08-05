/**
 * How large caption text should be, given how many entries must fit.
 *
 * Both surfaces have a FIXED height they must fill: the camera stage is always a
 * 16:9 frame, and the overlay is whatever height the operator dragged it to
 * (which is now authoritative — see `effectiveHeight` in
 * electron/captions/caption-window-manager.js). So "show more history" cannot
 * mean "grow the window"; it has to mean "make the text smaller", and showing
 * less history should make the text larger rather than leaving dead space.
 *
 * Deliberately computed rather than measured. The offscreen window that feeds the
 * virtual camera has no layout feedback loop to observe, so a
 * measure-then-adjust scheme would settle a frame or more late and could oscillate
 * on-camera. A closed-form multiplier renders correctly on the first frame.
 */

/** The entry count the unscaled design is drawn for. */
export const BASELINE_HISTORY_ENTRIES = 6;

/** Bounds on the multiplier, so neither extreme becomes unreadable or absurd. */
export const MIN_HISTORY_MULTIPLIER = 0.62;
export const MAX_HISTORY_MULTIPLIER = 1.85;

export const MIN_HISTORY_ENTRIES = 3;
export const MAX_HISTORY_ENTRIES = 10;

export function clampHistoryEntries(value: unknown): number {
  // `unset` and `out of range` are different, and conflating them with `|| baseline`
  // was wrong: 0 is falsy but is a perfectly real number that should clamp to the
  // minimum, not silently jump to the middle of the range.
  if (value === null || value === undefined || value === '') {
    return BASELINE_HISTORY_ENTRIES;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return BASELINE_HISTORY_ENTRIES;
  return Math.max(
    MIN_HISTORY_ENTRIES,
    Math.min(MAX_HISTORY_ENTRIES, Math.round(parsed)),
  );
}

/**
 * Scale factor relative to the baseline design, from the entry count alone.
 *
 * Stacked text height grows linearly with both the font size and the number of
 * entries, so filling a fixed height means the multiplier goes as
 * `baseline / entries`. Halving the entries does not quite double the useful size
 * in practice — longer utterances wrap onto a second line and consume the slack —
 * so the ratio is softened with a square root, which is what keeps three entries
 * from rendering comically large.
 */
export function historyFontMultiplier(historyEntries: unknown): number {
  const entries = clampHistoryEntries(historyEntries);
  const raw = Math.sqrt(BASELINE_HISTORY_ENTRIES / entries);
  const rounded = Math.round(raw * 1000) / 1000;
  return Math.max(
    MIN_HISTORY_MULTIPLIER,
    Math.min(MAX_HISTORY_MULTIPLIER, rounded),
  );
}

/**
 * The single number a surface multiplies its font sizes by.
 *
 * The operator's Caption size slider and the history-driven fit are independent
 * concerns and compose: the slider expresses a preference, the multiplier makes
 * the chosen history actually fit. Bounded again after multiplying so an extreme
 * slider setting plus an extreme history count cannot combine into something
 * unreadable.
 */
export function captionFontScale(
  fontScale: unknown,
  historyEntries: unknown,
): number {
  const slider = Number(fontScale);
  const safeSlider =
    Number.isFinite(slider) && slider > 0 ? Math.min(2, Math.max(0.5, slider)) : 1;
  const combined = safeSlider * historyFontMultiplier(historyEntries);
  const rounded = Math.round(combined * 1000) / 1000;
  return Math.max(0.5, Math.min(2.4, rounded));
}
