import { describe, expect, it } from 'vitest';

import { reviewReadiness, type ReadinessInput } from './readiness';

const ready: ReadinessInput = {
  credentialAvailable: true,
  microphoneAvailable: true,
  outputMode: 'overlays',
  cameraInstalled: true,
  cameraSupported: true,
};

describe('reviewReadiness', () => {
  it('reports all clear when nothing is outstanding', () => {
    const review = reviewReadiness(ready);
    expect(review.allClear).toBe(true);
    expect(review.outstanding).toEqual([]);
    expect(review.canStart).toBe(true);
  });

  it('blocks Start only for a missing API key', () => {
    const review = reviewReadiness({ ...ready, credentialAvailable: false });
    expect(review.canStart).toBe(false);
    expect(review.outstanding.map((step) => step.id)).toEqual(['credential']);
  });

  it('does not block Start for a missing microphone', () => {
    // Meeting audio from the far side is still captioned, which is most of the
    // value. Refusing to start would take away a working session.
    const review = reviewReadiness({ ...ready, microphoneAvailable: false });
    expect(review.canStart).toBe(true);
    expect(review.allClear).toBe(false);
    expect(review.outstanding.map((step) => step.id)).toEqual(['microphone']);
  });

  it('omits the camera step entirely in on-screen mode', () => {
    const review = reviewReadiness({
      ...ready,
      outputMode: 'overlays',
      cameraInstalled: false,
    });
    expect(review.steps.map((step) => step.id)).toEqual([
      'credential',
      'microphone',
    ]);
    expect(review.allClear).toBe(true);
  });

  it('raises the camera step in camera mode when it is not installed', () => {
    const review = reviewReadiness({
      ...ready,
      outputMode: 'virtual-camera',
      cameraInstalled: false,
    });
    expect(review.outstanding.map((step) => step.id)).toEqual(['camera']);
    // Advisory: the camera stage still renders, and capturing that window in OBS
    // is a path this app documents.
    expect(review.canStart).toBe(true);
  });

  it('treats a missing health report as installed, never as broken', () => {
    // Reporting "not installed" from an absent report told operators with a
    // perfectly working camera to reinstall it.
    const review = reviewReadiness({
      ...ready,
      outputMode: 'virtual-camera',
      cameraInstalled: null,
    });
    expect(review.allClear).toBe(true);
  });

  it('points at OBS instead of an install button when the platform cannot host it', () => {
    const review = reviewReadiness({
      ...ready,
      outputMode: 'virtual-camera',
      cameraSupported: false,
      cameraInstalled: false,
    });
    const camera = review.steps.find((step) => step.id === 'camera');
    expect(camera?.action).toBeNull();
    expect(camera?.detail).toMatch(/OBS/);
    // Nothing is outstanding: there is no action here, so an unresolvable row must
    // not sit in the checklist forever.
    expect(review.allClear).toBe(true);
  });

  it('orders outstanding steps so the blocker comes first', () => {
    const review = reviewReadiness({
      ...ready,
      credentialAvailable: false,
      microphoneAvailable: false,
      outputMode: 'virtual-camera',
      cameraInstalled: false,
    });
    expect(review.outstanding.map((step) => step.id)).toEqual([
      'credential',
      'microphone',
      'camera',
    ]);
  });

  it('gives every step an imperative title and a reason', () => {
    const review = reviewReadiness({
      ...ready,
      outputMode: 'virtual-camera',
    });
    for (const step of review.steps) {
      expect(step.title).not.toMatch(/^(No|Missing|Not )/);
      expect(step.detail.length).toBeGreaterThan(20);
    }
  });
});
