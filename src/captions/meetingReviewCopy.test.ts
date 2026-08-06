import { describe, expect, it } from 'vitest';

import {
  formatDuration,
  formatSize,
  reviewCopy,
  reviewFacts,
  reviewHeading,
  trackCount,
} from './meetingReviewCopy';
import type { MeetingRecordManifest } from './types';

const pending: MeetingRecordManifest = {
  sessionId: 's1',
  audioRetention: 'pending',
  channelAvailability: { microphone: true, system: true },
};

describe('reviewHeading', () => {
  it('asks the question while the decision is open', () => {
    // It used to read "Meeting saved" - answering something nobody wondered about
    // while the actual decision sat in the middle of the body text.
    expect(reviewHeading(pending, 'stopped')).toBe("Keep this meeting's audio?");
    expect(reviewHeading(pending, 'stopped')).toMatch(/\?$/);
  });

  it('names the interruption when the meeting is being recovered', () => {
    expect(reviewHeading(pending, 'recovered')).toMatch(/interrupted\?$/);
  });

  it('states the outcome once decided, and stops asking', () => {
    expect(reviewHeading({ ...pending, audioRetention: 'kept' }, 'stopped')).toBe(
      'Audio kept',
    );
    expect(
      reviewHeading({ ...pending, audioRetention: 'discarded' }, 'stopped'),
    ).toBe('Audio deleted');
    for (const retention of ['kept', 'discarded', 'unavailable'] as const) {
      expect(reviewHeading({ ...pending, audioRetention: retention }, 'stopped')).not.toMatch(
        /\?/,
      );
    }
  });

  it('does not claim audio exists when none was recorded', () => {
    expect(reviewHeading({ ...pending, audioRetention: 'unavailable' }, 'stopped')).toBe(
      'Transcript saved',
    );
  });
});

describe('reviewCopy', () => {
  it('says what is already safe before what is being decided', () => {
    const copy = reviewCopy(pending, 'stopped');
    expect(copy).toMatch(/transcript is saved either way/i);
  });

  it('states the consequence of each choice', () => {
    const copy = reviewCopy(pending, 'stopped');
    expect(copy).toMatch(/keeping it writes playable files/i);
    expect(copy).toMatch(/cannot be undone/i);
  });

  it('drops the jargon the old copy led with', () => {
    const copy = reviewCopy(pending, 'stopped');
    expect(copy).not.toMatch(/audio backup/i);
    expect(copy).not.toMatch(/discard/i);
  });

  it('explains why a recovered meeting is being asked about at all', () => {
    expect(reviewCopy(pending, 'recovered')).toMatch(/ended without a decision/i);
  });

  it('never promises playable files after a deletion', () => {
    const copy = reviewCopy({ ...pending, audioRetention: 'discarded' }, 'stopped');
    expect(copy).toMatch(/deleted/i);
    expect(copy).toMatch(/transcript is still saved/i);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, 'under a minute'],
    [20_000, 'under a minute'],
    [60_000, '1 minute'],
    [120_000, '2 minutes'],
    [45 * 60_000, '45 minutes'],
    [60 * 60_000, '1 hour'],
    [90 * 60_000, '1 hour 30 min'],
    [125 * 60_000, '2 hours 5 min'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatSize', () => {
  it('reports megabytes below a gigabyte and never rounds to zero', () => {
    expect(formatSize(172_800_000)).toBe('173 MB');
    expect(formatSize(1_000)).toBe('1 MB');
  });

  it('switches to gigabytes when the number would stop being readable', () => {
    expect(formatSize(2_400_000_000)).toBe('2.4 GB');
  });
});

describe('trackCount', () => {
  it('counts only channels that were actually captured', () => {
    expect(trackCount(pending)).toBe(2);
    expect(
      trackCount({ ...pending, channelAvailability: { microphone: true, system: false } }),
    ).toBe(1);
    expect(trackCount({ ...pending, channelAvailability: {} })).toBe(0);
    expect(trackCount(undefined)).toBe(0);
  });
});

describe('reviewFacts', () => {
  it('states duration, captions and the disk cost of keeping', () => {
    // 30 min x 2 tracks x 48 KB/s = 172.8 MB.
    const facts = reviewFacts({
      ...pending,
      startedAt: 1_000_000,
      endedAt: 1_000_000 + 30 * 60_000,
      captionCount: 84,
    });
    expect(facts).toBe('30 minutes · 84 captions · about 173 MB if kept');
  });

  it('halves the estimate when only one channel was captured', () => {
    const facts = reviewFacts({
      ...pending,
      startedAt: 0,
      endedAt: 30 * 60_000,
      channelAvailability: { microphone: true, system: false },
    });
    expect(facts).toMatch(/about 86 MB if kept/);
  });

  it('omits the size when there is no duration to compute it from', () => {
    const facts = reviewFacts({ ...pending, captionCount: 3 });
    expect(facts).toBe('3 captions · 2 audio tracks');
  });

  it('ignores a nonsensical time range rather than reporting a negative size', () => {
    const facts = reviewFacts({ ...pending, startedAt: 5_000, endedAt: 1_000 });
    expect(facts).not.toMatch(/-/);
    expect(facts).toBe('2 audio tracks');
  });

  it('returns null when there is nothing worth stating', () => {
    expect(reviewFacts({ sessionId: 's', audioRetention: 'pending' })).toBeNull();
    expect(reviewFacts(undefined)).toBeNull();
  });

  it('uses the singular for a single caption', () => {
    expect(reviewFacts({ sessionId: 's', audioRetention: 'pending', captionCount: 1 })).toBe(
      '1 caption',
    );
  });
});
