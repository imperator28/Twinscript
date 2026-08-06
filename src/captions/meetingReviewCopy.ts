// Wording for the post-meeting audio decision.
//
// The card used to lead with "Meeting saved" - answering a question nobody had asked
// - while the actual decision sat in the middle of a sentence reading "choose
// whether to keep or permanently discard the encrypted microphone and meeting audio
// backup". That is eight words of implementation detail for a thing the operator
// thinks of as "the recording", and it never said what either choice would do.
//
// It also gave no facts to decide with. Duration, track count and the size the files
// would take existed in the manifest but appeared nowhere; the only size guidance
// was a generic footnote in Settings about two one-hour tracks.

import type { MeetingRecordManifest } from './types';

export type ReviewOrigin = 'stopped' | 'recovered';

/**
 * 24 kHz mono 16-bit PCM is 48 KB per second per track. Used to state the cost of
 * keeping before the operator commits, rather than after.
 */
const BYTES_PER_SECOND_PER_TRACK = 48_000;

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return 'under a minute';
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourPart = `${hours} hour${hours === 1 ? '' : 's'}`;
  return minutes === 0 ? hourPart : `${hourPart} ${minutes} min`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** How many audio tracks were actually captured. */
export function trackCount(session?: MeetingRecordManifest | null): number {
  const availability = session?.channelAvailability;
  if (!availability) return 0;
  return Object.values(availability).filter(Boolean).length;
}

export function reviewHeading(
  session: MeetingRecordManifest | null | undefined,
  origin: ReviewOrigin,
): string {
  const retention = session?.audioRetention;
  if (retention === 'pending') {
    // The question the card exists to ask, asked plainly.
    return origin === 'recovered'
      ? 'Keep the audio from the meeting that was interrupted?'
      : "Keep this meeting's audio?";
  }
  if (retention === 'kept') return 'Audio kept';
  if (retention === 'discarded') return 'Audio deleted';
  return 'Transcript saved';
}

export function reviewCopy(
  session: MeetingRecordManifest | null | undefined,
  origin: ReviewOrigin,
): string {
  const retention = session?.audioRetention;
  if (retention === 'pending') {
    // Says what is already safe, then what each choice does. "Encrypted" appears as
    // the reason the files are not playable yet, which is the one place it is
    // load-bearing rather than reassurance.
    const recovered =
      origin === 'recovered'
        ? 'This meeting ended without a decision, so its audio is still waiting. '
        : '';
    return (
      `${recovered}The transcript is saved either way. The recording is encrypted and ` +
      'cannot be played yet: keeping it writes playable files for your microphone and ' +
      'the meeting audio, and deleting it cannot be undone.'
    );
  }
  if (retention === 'kept') {
    return 'Playable files for your microphone and the meeting audio are saved alongside the transcript.';
  }
  if (retention === 'discarded') {
    return 'The recording was deleted. The transcript is still saved.';
  }
  return 'The transcript is saved. No audio was recorded for this meeting.';
}

/**
 * The one-line fact strip under the question: how long, how many tracks, and how
 * much disk keeping it costs. Null when there is nothing worth stating.
 */
export function reviewFacts(
  session: MeetingRecordManifest | null | undefined,
): string | null {
  if (!session) return null;
  const parts: string[] = [];

  // Checked for presence, not truthiness: a timestamp of 0 is a real value, and
  // `startedAt && ...` silently discarded it along with the range that followed.
  const { startedAt, endedAt } = session;
  const hasRange =
    typeof startedAt === 'number' &&
    typeof endedAt === 'number' &&
    endedAt > startedAt;
  const elapsed = hasRange ? endedAt - startedAt : 0;
  if (elapsed > 0) parts.push(formatDuration(elapsed));

  if (session.captionCount) {
    parts.push(`${session.captionCount} caption${session.captionCount === 1 ? '' : 's'}`);
  }

  const tracks = trackCount(session);
  if (tracks > 0 && elapsed > 0) {
    const bytes = (elapsed / 1000) * BYTES_PER_SECOND_PER_TRACK * tracks;
    parts.push(`about ${formatSize(bytes)} if kept`);
  } else if (tracks > 0) {
    parts.push(`${tracks} audio track${tracks === 1 ? '' : 's'}`);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}
