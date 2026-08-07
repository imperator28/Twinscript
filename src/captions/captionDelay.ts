// Caption responsiveness: how long the transcriber waits before committing text.
//
// The value goes straight to OpenAI's transcription `delay` parameter. The control used to
// be a dropdown reading "Fastest / Fast / Stable" with no stated consequence, which is a
// choice presented as free - so of course the answer is always Fastest.
//
// There is a real cost. Waiting longer lets the model hear more of the utterance before it
// commits, which matters most for exactly the things this app is for: part numbers,
// dimensions, supplier names, and Chinese homophones that only resolve from context. Wait
// less and text appears sooner but is rewritten more often as the model catches up.

export type DelayProfile = 'minimal' | 'low' | 'default';

export interface DelayOption {
  profile: DelayProfile;
  /** Names the behaviour, not the setting: "Fastest" says nothing about the trade. */
  label: string;
  /** The consequence, in one sentence, in both directions. */
  detail: string;
}

/**
 * Ordered fastest to steadiest, so a slider's left-to-right matches "sooner to surer".
 * The index IS the slider value; nothing else may reorder this.
 */
export const DELAY_OPTIONS: readonly DelayOption[] = [
  {
    profile: 'minimal',
    label: 'Fastest',
    detail:
      'Text appears almost as it is spoken, and is rewritten most often as the model hears the rest of the sentence.',
  },
  {
    profile: 'low',
    label: 'Balanced',
    detail:
      'A short wait before committing. Captions still feel live, with noticeably fewer rewrites than Fastest.',
  },
  {
    profile: 'default',
    label: 'Most accurate',
    detail:
      'The longest wait. Best for part numbers, dimensions and names, which are the words most often corrected after the fact.',
  },
] as const;

/** The shipped default, and the one to return to when a stored value is unrecognised. */
export const DEFAULT_DELAY_PROFILE: DelayProfile = 'low';

export function delayIndex(profile: string | null | undefined): number {
  const index = DELAY_OPTIONS.findIndex((option) => option.profile === profile);
  // An unknown value resolves to the default rather than to index 0, which would silently
  // move an operator to Fastest - the option with the most visible downside.
  return index >= 0
    ? index
    : DELAY_OPTIONS.findIndex((option) => option.profile === DEFAULT_DELAY_PROFILE);
}

export function delayProfileAt(index: number): DelayProfile {
  const clamped = Math.min(DELAY_OPTIONS.length - 1, Math.max(0, Math.round(index)));
  return DELAY_OPTIONS[clamped].profile;
}

export function delayOption(profile: string | null | undefined): DelayOption {
  return DELAY_OPTIONS[delayIndex(profile)];
}
