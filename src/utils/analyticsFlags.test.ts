/**
 * Tests for the Analytics Flags view computation (utils/analyticsFlags.ts).
 *
 * All flags are computed in-memory from pipeline entries — no Firestore.
 * Fixed epochs use PDT (UTC-7) in August 2026 for the PT wall-clock math.
 */
import type { DocumentData } from 'firebase/firestore';
import {
  getSegmentFlags,
  getDayLevelFlags,
  getParentRowFlags,
  isShiftLevelFlag,
} from './analyticsFlags';

const DAY = Date.UTC(2026, 7, 24); // 2026-08-24T00:00:00Z

/** PT wall-clock → epoch ms (PDT = UTC-7). */
function pt(dayOffset: number, hh: number, mm: number): number {
  return DAY + dayOffset * 86400000 + (hh + 7) * 3600000 + mm * 60000;
}

function seg(overrides: Record<string, unknown> = {}): DocumentData {
  return {
    id: 'seg_1',
    clockInManual: '08:00',
    clockOutManual: '17:00',
    complete: true,
    ...overrides,
  } as DocumentData;
}

const LAST = { isLastSegment: true };
const NOT_LAST = { isLastSegment: false };

describe('getSegmentFlags — guardrail markers', () => {
  it('flags an auto-closed segment', () => {
    expect(getSegmentFlags(seg({ autoClosed: true }), NOT_LAST)).toContain('auto_closed_shift');
  });

  it('exempts routine midnight-split parts unless also flagged (calculateFlags parity)', () => {
    const split = seg({ autoClosed: true, splitFromMidnight: true });
    expect(getSegmentFlags(split, NOT_LAST)).not.toContain('auto_closed_shift');
    const flaggedSplit = seg({ autoClosed: true, splitFromMidnight: true, flagged: true });
    expect(getSegmentFlags(flaggedSplit, NOT_LAST)).toContain('auto_closed_shift');
  });

  it('maps doc-level autoClosed/autoEndedLunch/anomaly to the LAST segment only', () => {
    const s = seg();
    expect(getSegmentFlags(s, { ...NOT_LAST, docAutoClosed: true, docAutoEndedLunch: true, docAnomaly: true }))
      .toEqual([]);
    const last = getSegmentFlags(s, { ...LAST, docAutoClosed: true, docAutoEndedLunch: true, docAnomaly: true });
    expect(last).toContain('auto_closed_shift');
    expect(last).toContain('auto_ended_lunch');
    expect(last).toContain('anomaly_detected');
  });
});

describe('getSegmentFlags — lunch pattern flags', () => {
  it('short_lunch under 20 minutes, long_lunch over 90 (manual fields)', () => {
    expect(getSegmentFlags(seg({ lunchOutManual: '12:00', lunchInManual: '12:15' }), NOT_LAST))
      .toContain('short_lunch');
    expect(getSegmentFlags(seg({ lunchOutManual: '12:00', lunchInManual: '13:40' }), NOT_LAST))
      .toContain('long_lunch');
    expect(getSegmentFlags(seg({ lunchOutManual: '12:00', lunchInManual: '12:45' }), NOT_LAST))
      .toEqual([]);
  });

  it('prefers system lunch spans (with Timestamp-like normalization)', () => {
    const fakeTs = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) });
    const s = seg({
      lunchOutSystemTime: fakeTs(pt(0, 12, 0)),
      lunchInSystemTime: fakeTs(pt(0, 12, 10)),
    });
    expect(getSegmentFlags(s, NOT_LAST)).toContain('short_lunch');
  });

  it('skips lunch flags for open shifts and skipped lunches', () => {
    expect(getSegmentFlags(seg({ complete: false, lunchOutManual: '12:00', lunchInManual: '12:10' }), NOT_LAST))
      .toEqual([]);
    expect(getSegmentFlags(seg({ skipLunch: true }), NOT_LAST)).toEqual([]);
  });
});

describe('getSegmentFlags — audit flags', () => {
  it('batch_submission when the system span is under 5 minutes', () => {
    const s = seg({ clockInSystem: pt(0, 8, 0), clockOutSystem: pt(0, 8, 3) });
    expect(getSegmentFlags(s, NOT_LAST)).toContain('batch_submission');
  });

  it('after_hours_submission on-site only: last segment, >=18:00 or <06:00 PT', () => {
    const s = seg();
    const onsiteLast = { ...LAST, isOnSite: true };
    expect(getSegmentFlags(s, { ...onsiteLast, completedAt: pt(0, 19, 0) })).toContain('after_hours_submission');
    expect(getSegmentFlags(s, { ...NOT_LAST, isOnSite: true, completedAt: pt(0, 19, 0) })).not.toContain('after_hours_submission');
    expect(getSegmentFlags(s, { ...onsiteLast, completedAt: pt(0, 12, 0) })).not.toContain('after_hours_submission');
    expect(getSegmentFlags(s, { ...onsiteLast, completedAt: pt(1, 3, 0) })).toContain('after_hours_submission');
  });

  it('after_hours_submission never fires for remote workers (identical timestamps)', () => {
    const s = seg();
    // Remote worker completing at 19:00 PT — would flag if on-site.
    expect(getSegmentFlags(s, { ...LAST, isOnSite: false, completedAt: pt(0, 19, 0) })).not.toContain('after_hours_submission');
    // Remote worker completing at 03:00 PT — same.
    expect(getSegmentFlags(s, { ...LAST, isOnSite: false, completedAt: pt(1, 3, 0) })).not.toContain('after_hours_submission');
    // Unknown work model (isOnSite omitted) — skipped as well.
    expect(getSegmentFlags(s, { ...LAST, completedAt: pt(0, 19, 0) })).not.toContain('after_hours_submission');
  });

  it('accepts Timestamp-like completedAt values', () => {
    const fakeTs = { toMillis: () => pt(0, 20, 0), toDate: () => new Date(pt(0, 20, 0)) };
    expect(getSegmentFlags(seg(), { ...LAST, isOnSite: true, completedAt: fakeTs })).toContain('after_hours_submission');
  });
});

describe('getSegmentFlags — projected (still-open) shifts', () => {
  it('suppresses lunch-pattern and batch flags on in-memory projections', () => {
    // A live shift projected to "now": 3-minute span, 100-minute open lunch.
    const projected = seg({
      complete: true,
      projectedClosed: true,
      clockInSystem: Date.UTC(2026, 7, 24, 15, 0, 0),
      clockOutSystem: Date.UTC(2026, 7, 24, 15, 3, 0), // 3-min span
      lunchOutManual: '12:00',
      lunchInManual: '13:40', // 100 min — but lunch is still ongoing in reality
    });
    const flags = getSegmentFlags(projected, NOT_LAST);
    expect(flags).not.toContain('batch_submission');
    expect(flags).not.toContain('long_lunch');
    expect(flags).not.toContain('short_lunch');
  });
});

describe('getDayLevelFlags — parent rows only', () => {
  it('very_long_day over 11h, very_short_day under 4h (complete days)', () => {
    expect(getDayLevelFlags({ dayComplete: true, totalWorkMinutes: 690 } as DocumentData)).toContain('very_long_day');
    expect(getDayLevelFlags({ dayComplete: true, totalWorkMinutes: 180 } as DocumentData)).toContain('very_short_day');
    expect(getDayLevelFlags({ dayComplete: true, totalWorkMinutes: 480 } as DocumentData)).toEqual([]);
  });

  it('gates on completeness: incomplete days get no day flags, projected-open days do', () => {
    expect(getDayLevelFlags({ dayComplete: false, totalWorkMinutes: 690 } as DocumentData)).toEqual([]);
    expect(getDayLevelFlags({ dayComplete: false, projectedOpen: true, totalWorkMinutes: 690 } as DocumentData))
      .toContain('very_long_day');
  });

  it('uses per-part completeness for synthetic exploded parts', () => {
    expect(getDayLevelFlags({ synthetic: true, complete: true, totalWorkMinutes: 690 } as DocumentData))
      .toContain('very_long_day');
    expect(getDayLevelFlags({ synthetic: true, complete: false, totalWorkMinutes: 690 } as DocumentData)).toEqual([]);
  });

  it('very_short_day requires a nonzero total (empty days are not "short")', () => {
    expect(getDayLevelFlags({ dayComplete: true, totalWorkMinutes: 0 } as DocumentData)).toEqual([]);
  });
});

describe('row scoping', () => {
  it('day-level flags are never shift-level', () => {
    expect(isShiftLevelFlag('very_long_day')).toBe(false);
    expect(isShiftLevelFlag('very_short_day')).toBe(false);
    expect(isShiftLevelFlag('missing_lunch')).toBe(false);
    expect(isShiftLevelFlag('auto_closed_shift')).toBe(true);
  });

  it('getParentRowFlags unions day-level, child, and extra flags with dedupe', () => {
    const day = { dayComplete: true, totalWorkMinutes: 690 } as DocumentData;
    const out = getParentRowFlags(day, [['short_lunch'], ['short_lunch', 'batch_submission']], ['missing_lunch']);
    expect(out).toContain('very_long_day');
    expect(out).toContain('missing_lunch');
    expect(out).toContain('short_lunch');
    expect(out).toContain('batch_submission');
    expect(out.filter(f => f === 'short_lunch')).toHaveLength(1);
  });
});
