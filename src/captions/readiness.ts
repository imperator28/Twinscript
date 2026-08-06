// What has to be true before a meeting can be captioned, and how badly each thing
// matters.
//
// The control panel used to put Start - a 44px pill, the most prominent control on
// the window - directly in the header of a fresh install, where pressing it simply
// failed. The three prerequisites (an API key, microphone access, and in camera
// mode an installed virtual camera) were each discoverable only by failing, and one
// of them lived on a different tab. This module names them so the panel can show
// them in order instead.
//
// Severity is deliberately not uniform. Only a missing API key stops everything, so
// only it blocks Start. A missing microphone still leaves the far side of the call
// captioned from meeting audio, and a missing virtual camera still leaves the camera
// stage rendering for OBS window capture - a path this app documents and recommends.
// Blocking those would take away a working choice the operator may have made on
// purpose.

export type ReadinessId = 'credential' | 'microphone' | 'camera';

export type ReadinessSeverity = 'blocking' | 'advisory';

export interface ReadinessStep {
  id: ReadinessId;
  /** Imperative, names the thing rather than the state: "Add your OpenAI key". */
  title: string;
  /** One sentence on what does not work until it is done. */
  detail: string;
  done: boolean;
  severity: ReadinessSeverity;
  /** Label for the control that resolves it, or null when nothing can be done here. */
  action: string | null;
}

export interface ReadinessInput {
  /**
   * The operator chose "Not now". Advisory steps stop being listed; blocking ones
   * never can be, because dismissing a blocker would leave Start disabled with
   * nothing on screen explaining why.
   */
  advisoriesDismissed?: boolean;
  /** A usable API key is present in secure storage. */
  credentialAvailable: boolean;
  /** At least one input device is enumerable, which requires granted permission. */
  microphoneAvailable: boolean;
  outputMode: 'overlays' | 'virtual-camera';
  /**
   * Tri-state on purpose. `null` means no health report has arrived yet, which is
   * not the same as "not installed" - reporting the latter would tell an operator
   * with a working camera to reinstall it.
   */
  cameraInstalled: boolean | null;
  /** `false` only when the platform positively cannot host the camera. */
  cameraSupported: boolean | null;
}

export interface ReadinessReview {
  steps: ReadinessStep[];
  /** Steps not yet done, in the order they should be tackled. */
  outstanding: ReadinessStep[];
  /** True when nothing outstanding is blocking. Drives whether Start is enabled. */
  canStart: boolean;
  /** True when nothing remains to show, so the checklist can disappear entirely. */
  allClear: boolean;
  /**
   * Whether to offer "Not now". Only when everything left is advisory: a checklist
   * you can dismiss must never be the only explanation for a disabled Start button.
   */
  canDismiss: boolean;
}

export function reviewReadiness(input: ReadinessInput): ReadinessReview {
  const steps: ReadinessStep[] = [
    {
      id: 'credential',
      title: 'Add your OpenAI API key',
      detail:
        'Speech is transcribed and translated by OpenAI, so nothing can be captioned without a key.',
      done: input.credentialAvailable,
      severity: 'blocking',
      action: 'Add key',
    },
    {
      id: 'microphone',
      title: 'Allow microphone access',
      detail:
        'Without it your own speech is not captioned. Meeting audio from the far side still is.',
      done: input.microphoneAvailable,
      severity: 'advisory',
      action: 'Allow access',
    },
  ];

  // Only relevant in camera mode. In on-screen mode the camera is not part of the
  // path at all, and listing it would be noise the operator has to learn to ignore.
  if (input.outputMode === 'virtual-camera') {
    if (input.cameraSupported === false) {
      // macOS and any non-Windows host land here. There is no install to perform -
      // a virtual camera on macOS needs a notarized system extension, which this app
      // does not ship - so the step exists to be findable, never to be outstanding.
      // The checklist must be completable on every platform.
      steps.push({
        id: 'camera',
        title: 'Use OBS for the camera feed',
        detail:
          'This system cannot host the virtual camera. Capture the Twinscript Camera Stage window in OBS instead.',
        done: true,
        severity: 'advisory',
        // Nothing to press: the operator's next step is in another application.
        action: null,
      });
    } else {
      steps.push({
        id: 'camera',
        title: 'Install the virtual camera',
        detail:
          'Until it is installed, Twinscript is not listed as a camera in Teams or Zoom. The camera stage still renders for OBS window capture.',
        // An absent report is treated as done so a working camera is never accused
        // of being missing. A real report saying `installed: false` still shows.
        done: input.cameraInstalled !== false,
        severity: 'advisory',
        action: 'Install camera',
      });
    }
  }

  const unfinished = steps.filter((step) => !step.done);
  const blocked = unfinished.some((step) => step.severity === 'blocking');
  // A dismissal hides advisories only. Blocking steps survive it, so the checklist
  // cannot be dismissed into a state where Start is disabled for no visible reason.
  const outstanding = input.advisoriesDismissed
    ? unfinished.filter((step) => step.severity === 'blocking')
    : unfinished;

  return {
    steps,
    outstanding,
    canStart: !blocked,
    allClear: outstanding.length === 0,
    canDismiss: outstanding.length > 0 && !blocked,
  };
}
