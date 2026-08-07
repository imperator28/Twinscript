import { useId } from 'react';

/**
 * The Twinscript mark, inlined as SVG.
 *
 * Three things about this file are deliberate.
 *
 * 1. **The rounded corners belong to the artwork.** The mark is drawn on a white
 *    plate with `rx="111.26"` on a 500-unit square - a 22.252% corner radius. A
 *    container must therefore never clip it with a radius of its own: two
 *    different curves on the same edge is exactly what makes an app icon look
 *    counterfeit. `--brand-mark-radius` in the stylesheet carries that same
 *    percentage so a ring or hover surface can follow the plate edge instead of
 *    cutting across it.
 *
 * 2. **The IDs are per-instance.** The exported asset used generic names -
 *    `linear-gradient`, `linear-gradient-2`, `clippath` - which are global to the
 *    document once inlined. Two copies on one page (the header mark and the About
 *    card) would define the same IDs twice, and any other inlined SVG using the
 *    same obvious names would silently repaint this one. `useId()` namespaces
 *    every reference, so mounting it any number of times stays correct.
 *
 * 3. **The plate stays white in dark mode.** This is the application icon, not a
 *    glyph: recolouring it per theme would make the two themes ship different
 *    brands. Contrast against a dark surface comes from the surround.
 */
export function TwinscriptLogo({
  size = 28,
  className,
  label,
}: {
  size?: number;
  className?: string;
  /**
   * Omit wherever the app's name is already adjacent in text - which is
   * everywhere it is currently used. A mark that repeats the visible wordmark is
   * announced twice by a screen reader for no added meaning, so the default is
   * decorative.
   */
  label?: string;
}) {
  const uid = useId();
  const id = (part: string) => `twinscript-${part}-${uid}`;
  const gradient = {
    a: id('grad-a'),
    b: id('grad-b'),
    c: id('grad-c'),
    d: id('grad-d'),
  };
  const clip = id('clip');
  // Every gradient in the source shares one pair of stops; only the axis differs.
  const stops = (
    <>
      <stop offset="0" stopColor="#3f51ff" />
      <stop offset="1" stopColor="#82e0ff" />
    </>
  );

  return (
    <svg
      className={className}
      viewBox="0 0 500 500"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient
          id={gradient.a}
          x1="446.73"
          y1="196.49"
          x2="203.69"
          y2="196.49"
          gradientUnits="userSpaceOnUse"
        >
          {stops}
        </linearGradient>
        <linearGradient
          id={gradient.b}
          x1="66.72"
          y1="303.51"
          x2="309.75"
          y2="303.51"
          gradientUnits="userSpaceOnUse"
        >
          {stops}
        </linearGradient>
        <linearGradient
          id={gradient.c}
          x1="203.69"
          y1="193.71"
          x2="224.69"
          y2="193.71"
          gradientUnits="userSpaceOnUse"
        >
          {stops}
        </linearGradient>
        <linearGradient
          id={gradient.d}
          x1="446.73"
          y1="196.79"
          x2="203.69"
          y2="196.79"
          gradientUnits="userSpaceOnUse"
        >
          {stops}
        </linearGradient>
        <clipPath id={clip}>
          <path
            fill="none"
            d="M224.69,206.28v-22.09c-6.83-1.53-13.85-2.4-20.98-2.56,0,.52-.02,1.04-.02,1.56v19.87c7.26.21,14.29,1.32,21,3.22Z"
          />
        </clipPath>
      </defs>
      <rect fill="#fff" width="500" height="500" rx="111.26" ry="111.26" />
      <path
        fill={`url(#${gradient.a})`}
        d="M338.16,95.98c48.36,0,87.57,39.21,87.57,87.57v110.89c0,1.42-1.15,2.57-2.57,2.57h-110.89c-48.36,0-87.57-39.21-87.57-87.57v-25.9c0-48.36,39.21-87.57,87.57-87.57h25.9ZM338.16,74.98h-25.9c-29,0-56.26,11.29-76.77,31.8-20.51,20.51-31.8,47.77-31.8,76.77v25.9c0,29,11.29,56.26,31.8,76.77,20.51,20.51,47.77,31.8,76.77,31.8h110.89c13,0,23.57-10.57,23.57-23.57v-110.89c0-29-11.29-56.26-31.8-76.77-20.51-20.51-47.77-31.8-76.77-31.8h0Z"
      />
      <path
        fill={`url(#${gradient.b})`}
        d="M201.18,202.99c48.36,0,87.57,39.21,87.57,87.57v25.9c0,48.36-39.21,87.57-87.57,87.57h-110.89c-1.42,0-2.57-1.15-2.57-2.57v-110.89c0-48.36,39.21-87.57,87.57-87.57h25.9ZM201.18,181.99h-25.9c-29,0-56.26,11.29-76.77,31.8-20.51,20.51-31.8,47.77-31.8,76.77v110.89c0,13,10.57,23.57,23.57,23.57h110.89c29,0,56.26-11.29,76.77-31.8,20.51-20.51,31.8-47.77,31.8-76.77v-25.9c0-29-11.29-56.26-31.8-76.77-20.51-20.51-47.77-31.8-76.77-31.8h0Z"
      />
      <path
        fill={`url(#${gradient.c})`}
        d="M224.69,205.8v-21.65c-6.83-1.5-13.85-2.35-20.98-2.51,0,.51-.02,1.02-.02,1.53v19.48c7.26.2,14.29,1.29,21,3.16Z"
      />
      {/* The seam where the two counters interlock. Clipped to a sliver, which is
          why the path below looks like a duplicate of the first one. */}
      <g clipPath={`url(#${clip})`}>
        <path
          fill={`url(#${gradient.d})`}
          d="M338.16,94.27c48.36,0,87.57,39.99,87.57,89.32v113.11c0,1.45-1.15,2.62-2.57,2.62h-110.89c-48.36,0-87.57-39.99-87.57-89.32v-26.41c0-49.33,39.21-89.32,87.57-89.32h25.9ZM338.16,72.85h-25.9c-29,0-56.26,11.52-76.77,32.43-20.51,20.92-31.8,48.72-31.8,78.3v26.41c0,29.58,11.29,57.39,31.8,78.3,20.51,20.92,47.77,32.43,76.77,32.43h110.89c13,0,23.57-10.79,23.57-24.04v-113.11c0-29.58-11.29-57.39-31.8-78.3-20.51-20.92-47.77-32.43-76.77-32.43h0Z"
        />
      </g>
    </svg>
  );
}
