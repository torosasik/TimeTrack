/**
 * Tests for the 2026-08 adjustment guardrails:
 *  - validateSegmentChronology (cross-midnight-aware sequence validation)
 *  - getFuturePunchError (future-timestamp rejection)
 *  - getSegmentOverlapError (same-day shift overlap rejection)
 */
import {
  validateSegmentChronology,
  getFuturePunchError,
  getSegmentOverlapError,
} from './timeValidation';

const NOW = 1_800_000_000_000; // fixed reference instant

describe('validateSegmentChronology', () => {
  it('accepts a valid same-day shift with lunch', () => {
    expect(
      validateSegmentChronology({
        clockInManual: '09:00',
        lunchOutManual: '12:00',
        lunchInManual: '12:30',
        clockOutManual: '17:00',
      }),
    ).toEqual([]);
  });

  it('rejects a zero-length shift (clock-out equal to clock-in)', () => {
    const errors = validateSegmentChronology({
      clockInManual: '09:00',
      clockOutManual: '09:00',
    });
    expect(errors).toContain('Clock out must be after clock in');
  });

  it('documents the S6 convention: an earlier clock-out is read as overnight', () => {
    // 09:00 -> 08:00 cannot be distinguished from a 23h overnight shift using
    // HH:MM alone; the system-wide S6 wrap convention treats it as next-day.
    expect(
      validateSegmentChronology({
        clockInManual: '09:00',
        clockOutManual: '08:00',
      }),
    ).toEqual([]);
  });

  it('ACCEPTS a valid overnight shift (22:00 -> 06:00 next day)', () => {
    expect(
      validateSegmentChronology({
        clockInManual: '22:00',
        clockOutManual: '06:00',
      }),
    ).toEqual([]);
  });

  it('rejects an overnight wrap that is still not later (22:00 -> 22:00)', () => {
    const errors = validateSegmentChronology({
      clockInManual: '22:00',
      clockOutManual: '22:00',
    });
    expect(errors).toContain('Clock out must be after clock in');
  });

  it('rejects lunch-in earlier than lunch-out', () => {
    const errors = validateSegmentChronology({
      clockInManual: '09:00',
      lunchOutManual: '12:00',
      lunchInManual: '11:00',
      clockOutManual: '17:00',
    });
    expect(errors).toContain('Lunch in must be after lunch out');
  });

  it('rejects lunch-out at clock-in (zero work before lunch)', () => {
    const errors = validateSegmentChronology({
      clockInManual: '09:00',
      lunchOutManual: '09:00',
      lunchInManual: '09:30',
      clockOutManual: '17:00',
    });
    expect(errors).toContain('Lunch out must be after clock in');
  });

  it('catches lunch-out "before" clock-in via the clock-out bound (wrap)', () => {
    // 08:30 wraps to next-day under S6, so the inversion surfaces as
    // lunch-out landing after the (same-day) clock-out instead.
    const errors = validateSegmentChronology({
      clockInManual: '09:00',
      lunchOutManual: '08:30',
      lunchInManual: '09:30',
      clockOutManual: '17:00',
    });
    expect(errors).toContain('Lunch out must be before clock out');
  });

  it('rejects lunch-out after clock-out', () => {
    const errors = validateSegmentChronology({
      clockInManual: '09:00',
      lunchOutManual: '18:00',
      lunchInManual: '18:30',
      clockOutManual: '17:00',
    });
    expect(errors).toContain('Lunch out must be before clock out');
  });

  it('accepts lunch-in equal to clock-out (same-minute punch)', () => {
    const errors = validateSegmentChronology({
      clockInManual: '09:00',
      lunchOutManual: '12:00',
      lunchInManual: '17:00',
      clockOutManual: '17:00',
    });
    expect(errors).not.toContain('Lunch in must be before clock out');
  });

  it('rejects lunch-in after clock-out', () => {
    const errors = validateSegmentChronology({
      clockInManual: '09:00',
      lunchOutManual: '12:00',
      lunchInManual: '18:00',
      clockOutManual: '17:00',
    });
    expect(errors).toContain('Lunch in must be before clock out');
  });

  it('rejects a partial lunch pair (lunchOut without lunchIn) when closed', () => {
    const errors = validateSegmentChronology({
      clockInManual: '09:00',
      lunchOutManual: '12:00',
      clockOutManual: '17:00',
    });
    expect(errors).toContain('Both lunch times required or leave both empty');
  });

  it('rejects a partial lunch pair (lunchIn without lunchOut)', () => {
    const errors = validateSegmentChronology({
      clockInManual: '09:00',
      lunchInManual: '12:30',
      clockOutManual: '17:00',
    });
    expect(errors).toContain('Both lunch times required or leave both empty');
  });

  it('requires clock-out unless allowOpen', () => {
    expect(
      validateSegmentChronology({ clockInManual: '09:00' }),
    ).toContain('Clock out is required');
    expect(
      validateSegmentChronology({ clockInManual: '09:00' }, { allowOpen: true }),
    ).toEqual([]);
  });

  it('permits an in-progress lunch on an open shift only with allowOpen', () => {
    const seg = { clockInManual: '09:00', lunchOutManual: '12:00' };
    expect(validateSegmentChronology(seg, { allowOpen: true })).toEqual([]);
    expect(validateSegmentChronology(seg)).toContain(
      'Both lunch times required or leave both empty',
    );
  });

  it('skips lunch checks entirely when lunch is skipped', () => {
    expect(
      validateSegmentChronology({
        clockInManual: '09:00',
        clockOutManual: '17:00',
        skipLunch: true,
      }),
    ).toEqual([]);
  });

  it('requires clock-in', () => {
    expect(validateSegmentChronology({ clockOutManual: '17:00' })).toContain(
      'Clock in is required',
    );
  });

  it('handles a midnight-straddling lunch (lunchIn after midnight)', () => {
    expect(
      validateSegmentChronology({
        clockInManual: '20:00',
        lunchOutManual: '23:30',
        lunchInManual: '00:10',
        clockOutManual: '04:00',
      }),
    ).toEqual([]);
  });
});

describe('getFuturePunchError', () => {
  it('returns null when all epochs are in the past', () => {
    expect(
      getFuturePunchError(
        { clockInSystem: NOW - 8 * 3600_000, clockOutSystem: NOW - 3600_000 },
        NOW,
      ),
    ).toBeNull();
  });

  it('rejects a future clock-out', () => {
    expect(
      getFuturePunchError({ clockInSystem: NOW - 3600_000, clockOutSystem: NOW + 60000 }, NOW),
    ).toBe('Clock out cannot be set to a time in the future.');
  });

  it('rejects a future lunch-in', () => {
    expect(
      getFuturePunchError({ lunchOutSystem: NOW - 3600_000, lunchInSystem: NOW + 60000 }, NOW),
    ).toBe('Lunch in cannot be set to a time in the future.');
  });

  it('ignores absent (non-numeric) fields', () => {
    expect(getFuturePunchError({}, NOW)).toBeNull();
  });
});

describe('getSegmentOverlapError', () => {
  const seg = (startH: number, endH: number) => ({
    clockInSystem: NOW + startH * 3600_000,
    clockOutSystem: NOW + endH * 3600_000,
  });

  it('returns null for non-overlapping shifts (unsorted input)', () => {
    expect(getSegmentOverlapError([seg(12, 17), seg(6, 11)])).toBeNull();
  });

  it('returns null for touching shifts (end == next start)', () => {
    expect(getSegmentOverlapError([seg(6, 11), seg(11, 15)])).toBeNull();
  });

  it('rejects overlapping shifts regardless of input order', () => {
    expect(getSegmentOverlapError([seg(10, 14), seg(6, 11)])).toMatch(/overlap/);
  });

  it('rejects a shift fully contained in another', () => {
    expect(getSegmentOverlapError([seg(6, 18), seg(9, 10)])).toMatch(/overlap/);
  });

  it('skips open segments (no clock-out epoch)', () => {
    expect(
      getSegmentOverlapError([seg(6, 11), { clockInSystem: NOW + 10 * 3600_000 }]),
    ).toBeNull();
  });
});