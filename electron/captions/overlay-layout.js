// Pure geometry for the two audience overlays.
//
// Kept free of Electron so Windows display situations that are awkward to
// reproduce by hand — a taskbar on the left or top edge, a secondary monitor at
// negative coordinates, a short work area at 150% scaling, a display narrower
// than the side-by-side threshold — are table-testable.
//
// Every input is a work area, never a display bounds: Windows subtracts the
// taskbar from `workArea` on whichever edge it sits, so honoring the work area
// is what keeps the overlays clear of it.

const DEFAULT_GEOMETRY = {
  margin: 28,
  gap: 10,
  stackedHeight: 142,
  sideBySideHeight: 174,
  maxStackedWidth: 1120,
  // Below this a side-by-side pair is too narrow to read, so the request falls
  // back to stacked rather than producing two unusable slivers.
  minSideBySideWidth: 1180,
  minWidth: 240,
  minHeight: 64,
};

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * Resolve the requested layout and the bounds for both overlays.
 *
 * Returns `{ layout, bounds: { en, zh } }` with integer bounds that always sit
 * inside `workArea`. `layout` is the layout actually used, which may differ from
 * the request when the display cannot accommodate it.
 */
function computeOverlayBounds({
  layout = 'stacked',
  workArea,
  geometry = {},
  sharedHeight,
} = {}) {
  const spec = { ...DEFAULT_GEOMETRY, ...geometry };
  const area = {
    x: Math.round(workArea?.x ?? 0),
    y: Math.round(workArea?.y ?? 0),
    width: Math.max(1, Math.round(workArea?.width ?? 0)),
    height: Math.max(1, Math.round(workArea?.height ?? 0)),
  };

  // A margin that would not leave a usable window collapses to zero rather than
  // pushing the overlays off a small display.
  const margin = area.width - spec.margin * 2 >= spec.minWidth ? spec.margin : 0;
  const verticalMargin = area.height > spec.margin * 3 ? spec.margin : 0;

  const wantsSideBySide =
    layout === 'side-by-side' && area.width >= spec.minSideBySideWidth;
  const resolved = wantsSideBySide ? 'side-by-side' : 'stacked';

  const bottom = area.y + area.height - verticalMargin;

  if (resolved === 'side-by-side') {
    const width = Math.max(
      spec.minWidth,
      Math.floor((area.width - margin * 2 - spec.gap) / 2),
    );
    const maxHeight = Math.max(
      1,
      Math.min(
        area.height - verticalMargin,
        Math.floor(area.height * 0.33),
      ),
    );
    const minimum = Math.min(spec.minHeight, maxHeight);
    const requested = Number.isFinite(sharedHeight)
      ? Math.round(sharedHeight)
      : spec.sideBySideHeight;
    const height = clamp(requested, minimum, maxHeight);
    const enY = clamp(
      bottom - height,
      area.y,
      area.y + area.height - height,
    );
    return {
      layout: resolved,
      bounds: {
        en: { x: area.x + margin, y: enY, width, height },
        zh: {
          x: area.x + margin + width + spec.gap,
          y: enY,
          width,
          height,
        },
      },
    };
  }

  const width = clamp(
    Math.min(spec.maxStackedWidth, area.width - margin * 2),
    spec.minWidth,
    area.width,
  );
  // Both overlays plus the gap have to fit above the bottom margin; a short work
  // area shrinks them instead of pushing the upper one off the top edge.
  const available = Math.max(1, area.height - verticalMargin);
  const workAreaCap = Math.floor((area.height * 0.45 - spec.gap) / 2);
  const availableCap = Math.floor((available - spec.gap) / 2);
  const maxHeight = Math.max(1, Math.min(workAreaCap, availableCap));
  const minimum = Math.min(spec.minHeight, maxHeight);
  const requested = Number.isFinite(sharedHeight)
    ? Math.round(sharedHeight)
    : spec.stackedHeight;
  const height = clamp(requested, minimum, maxHeight);
  const x = clamp(
    area.x + Math.floor((area.width - width) / 2),
    area.x,
    area.x + area.width - width,
  );
  const zhY = clamp(
    bottom - height,
    area.y,
    area.y + area.height - height,
  );
  const enY = clamp(zhY - spec.gap - height, area.y, zhY);

  return {
    layout: resolved,
    bounds: {
      en: { x, y: enY, width, height },
      zh: { x, y: zhY, width, height },
    },
  };
}

module.exports = { DEFAULT_GEOMETRY, computeOverlayBounds };
