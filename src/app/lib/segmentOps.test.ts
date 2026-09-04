/**
 * SSOT segment-minutes + write-side recalculation tests.
 *
 * computeSegmentWorkMinutes is the single canonical segment-minutes function
 * used by every write path (direct edits, closes) and read path (mapEntry,
 * Payroll rebuild). It is a HYBRID: stored workMinutes when it agrees with the
 * manual punch signal (preserves split-boundary accuracy), else the manual
 * punch times (so an edit — which updates only the *Manual strings —
 * propagates), else the system-timestamp span (manual absent).
 */
import {
  computeSegmentWorkMinutes,
  recalculateEntryTotals,
  recomputeSegmentSystemTimestamps,
  fieldToSystemField,
  getPreservedSegmentsForEdit,
  buildConsistentClosePatch,
} from './segmentOps';
import type { TimeSegment } from './database';
import { hhmmInZone } from '../../utils/timeView';

describe('getPreservedSegmentsForEdit — split-shift-safe correction', () => {
  // Regression for the Emir Korkut Ünal 2026-07-22 entry: a 3-segment
  // split-shift day (13 + 84 + 27 = 124 min) whose top-level clockIn mirrors
  // the LAST segment (11:31). The single-shift edit form must preserve the
  // earlier shifts, not collapse the day to one.
  const s1: TimeSegment = { id: 's1', clockInManual: '07:59', clockOutManual: '09:01', workMinutes: 13, complete: true };
  const s2: TimeSegment = { id: 's2', clockInManual: '09:33', clockOutManual: '11:00', workMinutes: 84, complete: true };
  const s3: TimeSegment = { id: 's3', clockInManual: '11:31', clockOutManual: '11:58', workMinutes: 27, complete: true };

  it('drops the last segment when it mirrors the root clockIn (multi-shift)', () => {
    const entry = { segments: [s1, s2, s3], clockInManual: '11:31' };
    const preserved = getPreservedSegmentsForEdit(entry);
    expect(preserved.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('returns [] for a single-shift day (last segment mirrors root)', () => {
    const entry = { segments: [s3], clockInManual: '11:31' };
    expect(getPreservedSegmentsForEdit(entry)).toEqual([]);
  });

  it('preserves ALL segments when the last does NOT mirror the root (legacy top-level shift)', () => {
    const entry = { segments: [s1, s2], clockInManual: '99:99' }; // current shift only in top-level
    expect(getPreservedSegmentsForEdit(entry).map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('handles an empty/undefined segments array', () => {
    expect(getPreservedSegmentsForEdit({ clockInManual: '11:31' })).toEqual([]);
  });

  it('before == after on a no-op correction (append mode preserves the full day total)', () => {
    // Load the entry into the edit form unchanged (clockIn 11:31, clockOut
    // 11:58). buildConsistentClosePatch with the preserved segments must yield
    // the FULL day total (124 min), identical to the "before" total — not the
    // collapsed single-shift 27 min that 'replace' produced.
    const entry = { segments: [s1, s2, s3], clockInManual: '11:31' };
    const patch = buildConsistentClosePatch({
      clockIn: '11:31',
      clockOut: '11:58',
      skipLunch: false,
      existingSegments: getPreservedSegmentsForEdit(entry),
      mode: 'append',
    });
    expect(patch.totalWorkMinutes).toBe(124); // 13 + 84 + 27, the full day
    expect(patch.segments).toHaveLength(3); // s1 + s2 + edited s3, not collapsed to 1
  });
});

describe('computeSegmentWorkMinutes — hybrid SSOT', () => {
  it('returns stored workMinutes when it agrees with the manual signal (non-edited)', () => {
    const seg: TimeSegment = {
      id: 's1', clockInManual: '09:00', clockOutManual: '17:00',
      workMinutes: 480, complete: true,
    };
    expect(computeSegmentWorkMinutes(seg)).toBe(480);
  });

  it('returns the MANUAL minutes when stored has diverged (edited shift)', () => {
    // clockOut edited 17:00 -> 18:00, but stored workMinutes (480) is stale.
    const seg: TimeSegment = {
      id: 's1', clockInManual: '09:00', clockOutManual: '18:00',
      workMinutes: 480, complete: true,
    };
    expect(computeSegmentWorkMinutes(seg)).toBe(540); // 9h, the EDITED total
  });

  it('keeps the accurate split value within the 1-min tolerance (no artifact)', () => {
    // A 23:59:59 close stored as '23:59' (27 manual) with stored 28 (system).
    // The hybrid must keep 28 (accurate), not regress to 27.
    const seg: TimeSegment = {
      id: 'd1', clockInManual: '23:32', clockOutManual: '23:59',
      workMinutes: 28, complete: true, splitFromMidnight: true,
    };
    expect(computeSegmentWorkMinutes(seg)).toBe(28);
  });

  it('handles a cross-midnight manual span (23:00 -> 02:00 = 3h)', () => {
    const seg: TimeSegment = {
      id: 's1', clockInManual: '23:00', clockOutManual: '02:00', complete: true,
    };
    expect(computeSegmentWorkMinutes(seg)).toBe(180);
  });

  it('subtracts a manual lunch', () => {
    const seg: TimeSegment = {
      id: 's1', clockInManual: '09:00', clockOutManual: '17:00',
      lunchOutManual: '12:00', lunchInManual: '12:30', complete: true,
    };
    expect(computeSegmentWorkMinutes(seg)).toBe(450); // 8h - 30m lunch
  });

  it('falls back to the system-timestamp span when manual punch times are absent', () => {
    const inSys = Date.UTC(2026, 6, 30, 9, 0, 0);
    const outSys = Date.UTC(2026, 6, 30, 17, 0, 0);
    const seg: TimeSegment = {
      id: 's1', clockInSystem: inSys, clockOutSystem: outSys, complete: true,
    };
    expect(computeSegmentWorkMinutes(seg)).toBe(480);
  });

  it('respects skipLunch (no deduction)', () => {
    const seg: TimeSegment = {
      id: 's1', clockInManual: '09:00', clockOutManual: '17:00',
      lunchOutManual: '12:00', lunchInManual: '12:30', skipLunch: true, complete: true,
    };
    expect(computeSegmentWorkMinutes(seg)).toBe(480);
  });
});

describe('recalculateEntryTotals — write-side SSOT', () => {
  it('recomputes the edited segment workMinutes + day total + totalHours', () => {
    // One segment, clockOut edited to 18:00, stale stored workMinutes 480.
    const segs: TimeSegment[] = [
      { id: 's1', clockInManual: '09:00', clockOutManual: '18:00', workMinutes: 480, complete: true },
    ];
    const out = recalculateEntryTotals(segs);
    expect(out.segments[0].workMinutes).toBe(540); // recomputed from manual
    expect(out.totalWorkMinutes).toBe(540);
    expect(out.totalHours).toBeCloseTo(9, 5);
  });

  it('sums multiple segments and recomputes only the divergent one', () => {
    const segs: TimeSegment[] = [
      { id: 's1', clockInManual: '08:00', clockOutManual: '12:00', workMinutes: 240, complete: true }, // consistent
      { id: 's2', clockInManual: '13:00', clockOutManual: '18:00', workMinutes: 300, complete: true }, // edited (was 17:00=240, now 18:00=300) — stored 300 already matches manual here
    ];
    const out = recalculateEntryTotals(segs);
    expect(out.totalWorkMinutes).toBe(540); // 240 + 300
  });

  it('leaves open segments (no clock-out) untouched', () => {
    const segs: TimeSegment[] = [
      { id: 'open', clockInManual: '09:00', complete: false },
      { id: 's1', clockInManual: '08:00', clockOutManual: '12:00', workMinutes: 240, complete: true },
    ];
    const out = recalculateEntryTotals(segs);
    expect(out.segments[0].complete).toBe(false);
    expect(out.totalWorkMinutes).toBe(240); // only the closed segment
  });
});

describe('fieldToSystemField', () => {
  it('maps each manual field to its system counterpart', () => {
    expect(fieldToSystemField('clockInManual')).toBe('clockInSystem');
    expect(fieldToSystemField('clockOutManual')).toBe('clockOutSystem');
    expect(fieldToSystemField('lunchOutManual')).toBe('lunchOutSystem');
    expect(fieldToSystemField('lunchInManual')).toBe('lunchInSystem');
  });
});

describe('recomputeSegmentSystemTimestamps — edit *System sync (SSOT)', () => {
  // Reproduces the reported bug: a manual edit updates *Manual but leaves
  // *System stale, so displays that prefer *System show the pre-edit time.
  // After recompute, *System must reflect the EDITED manual value.
  it('recomputes all *System fields from *Manual so the display shows the edited time', () => {
    const tz = 'America/Los_Angeles';
    // Original punch: 09:00–17:00 PDT on 2026-07-30 (stale system instants).
    const staleIn = Date.UTC(2026, 6, 30, 16, 0, 0); // 09:00 PDT
    const staleOut = Date.UTC(2026, 6, 31, 0, 0, 0); // 17:00 PDT
    // Employee edits clockOut 17:00 -> 18:00 (manual updated, system still stale).
    const seg: TimeSegment = {
      id: 's1',
      clockInManual: '09:00', clockOutManual: '18:00',
      clockInSystem: staleIn, clockOutSystem: staleOut,
      complete: true,
    };
    const out = recomputeSegmentSystemTimestamps(seg, '2026-07-30', tz);
    // clockOutSystem must now be 18:00 PDT = 01:00 UTC 07-31 (the EDITED time).
    expect(out.clockOutSystem).toBe(Date.UTC(2026, 6, 31, 1, 0, 0));
    expect(hhmmInZone(out.clockOutSystem!, tz)).toBe('18:00');
    // clockInSystem recomputed to match its manual (09:00 PDT), not stale.
    expect(hhmmInZone(out.clockInSystem!, tz)).toBe('09:00');
  });

  it('handles cross-midnight: clockOut earlier than clockIn lands on the next day', () => {
    const tz = 'America/Los_Angeles';
    const seg: TimeSegment = {
      id: 's1', clockInManual: '23:00', clockOutManual: '02:00', complete: true,
    };
    const out = recomputeSegmentSystemTimestamps(seg, '2026-07-30', tz);
    expect(hhmmInZone(out.clockInSystem!, tz)).toBe('23:00');
    // 02:00 on 07-31 PDT (next day)
    expect(hhmmInZone(out.clockOutSystem!, tz)).toBe('02:00');
    expect(out.clockOutSystem!).toBeGreaterThan(out.clockInSystem!);
  });

  it('recomputes lunch boundaries wrap-aware from clockIn', () => {
    const tz = 'America/Los_Angeles';
    const seg: TimeSegment = {
      id: 's1',
      clockInManual: '23:00', clockOutManual: '07:00',
      lunchOutManual: '23:30', lunchInManual: '00:15',
      complete: true,
    };
    const out = recomputeSegmentSystemTimestamps(seg, '2026-07-30', tz);
    expect(hhmmInZone(out.lunchOutSystem!, tz)).toBe('23:30');
    expect(hhmmInZone(out.lunchInSystem!, tz)).toBe('00:15');
    expect(out.lunchInSystem!).toBeGreaterThan(out.lunchOutSystem!);
  });

  it('only sets *System for fields that have a *Manual value', () => {
    const seg: TimeSegment = {
      id: 's1', clockInManual: '09:00', clockOutManual: '17:00', complete: true,
    };
    const out = recomputeSegmentSystemTimestamps(seg, '2026-07-30', 'America/Los_Angeles');
    expect(typeof out.clockInSystem).toBe('number');
    expect(typeof out.clockOutSystem).toBe('number');
    expect(out.lunchOutSystem).toBeUndefined();
    expect(out.lunchInSystem).toBeUndefined();
  });

  it('returns the segment unchanged when timezone or anchorDate is absent', () => {
    const seg: TimeSegment = { id: 's1', clockInManual: '09:00', clockOutManual: '17:00', complete: true };
    expect(recomputeSegmentSystemTimestamps(seg, undefined, 'UTC')).toBe(seg);
    expect(recomputeSegmentSystemTimestamps(seg, '2026-07-30', undefined)).toBe(seg);
  });

  // Regression for the resolveCorrectionRequest bug: approving a Clock In
  // correction (16:01 → 16:00) previously stamped cross-midnight / wrong-date
  // epochs on a duplicate segment, inflating its Payroll duration to 14+ hours
  // while the manual read 16:01–16:45. With the in-place edit + recompute +
  // recalculateEntryTotals, the shift stays on one date with the exact span.
  it('correcting clockIn 16:01→16:00 keeps the shift on one date with exact duration (no inflation)', () => {
    const tz = 'America/Los_Angeles';
    // Shift originally 16:01–16:45 on 2026-07-29; the correction sets clockIn to
    // 16:00 (manual updated, system epochs still the stale originals).
    const seg: TimeSegment = {
      id: 's1',
      clockInManual: '16:00', clockOutManual: '16:45',
      clockInSystem: Date.UTC(2026, 6, 29, 23, 1, 0),  // stale original 16:01 PDT
      clockOutSystem: Date.UTC(2026, 6, 29, 23, 45, 0), // stale original 16:45 PDT
      workMinutes: 44,
      complete: true,
    };
    const recomputed = recomputeSegmentSystemTimestamps(seg, '2026-07-29', tz);
    const { segments, totalWorkMinutes, totalHours } = recalculateEntryTotals([recomputed]);
    // Duration is exactly 45 min (16:00→16:45 = 0.75 h) — not 44 (stale), not
    // 14+ hours (epoch drift).
    expect(totalWorkMinutes).toBe(45);
    expect(totalHours).toBeCloseTo(0.75, 5);
    // The *System epochs stay on the same calendar date — a 45-minute span, no
    // next-day rollover from the evening times.
    expect(segments[0].clockOutSystem! - segments[0].clockInSystem!).toBe(45 * 60 * 1000);
    expect(hhmmInZone(segments[0].clockInSystem!, tz)).toBe('16:00');
    expect(hhmmInZone(segments[0].clockOutSystem!, tz)).toBe('16:45');
  });

  // Guard against the epoch-wrapping bug class: an evening clockOut (e.g. 16:45)
  // must not roll into the next day's UTC date when the shift is same-day.
  it('evening same-day times do not roll into the next UTC date', () => {
    const tz = 'America/Los_Angeles';
    const seg: TimeSegment = {
      id: 's1', clockInManual: '16:00', clockOutManual: '16:45', complete: true,
    };
    const out = recomputeSegmentSystemTimestamps(seg, '2026-07-29', tz);
    // 16:00 PDT = 23:00 UTC same day; 16:45 PDT = 23:45 UTC same day (PDT is UTC-7
    // in July, so local evening times map to the SAME UTC date, not the next).
    expect(out.clockOutSystem! - out.clockInSystem!).toBe(45 * 60 * 1000);
    expect(new Date(out.clockInSystem!).getUTCDate()).toBe(29);
    expect(new Date(out.clockOutSystem!).getUTCDate()).toBe(29);
  });
});
