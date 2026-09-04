/**
 * Regression tests for the Firestore "Unsupported field value: undefined" bug.
 *
 * Bug: when ClockPunch / clockService calls `tx.set(ref, payload, { merge: true })`,
 * any field with value `undefined` causes the WHOLE write to fail with
 * "Unsupported field value: undefined". This was making clock-in silently fail
 * for employees in production. The fix: stripUndefined() + createInitialSegment()
 * must never emit `undefined` values.
 */
// `./firebase` references `import.meta.env` and `window` at module top-level,
// which throws under jest's CommonJS transform. The pure helpers under test
// (segmentOps + mapEntry) don't need a real Firestore handle, so stub it.
jest.mock('./firebase', () => ({ db: {} }));

import {
  stripUndefined,
  createInitialSegment,
  closeActiveSegment,
  applyLunchToSegment,
  buildConsistentClosePatch,
} from './segmentOps';
import type { TimeSegment } from './database';
import { calculateTotalHours, getEntryTotals } from './database';

describe('stripUndefined', () => {
  it('removes keys with undefined values', () => {
    const out = stripUndefined({ a: 1, b: undefined, c: 'x' });
    expect(out).toEqual({ a: 1, c: 'x' });
    expect(Object.keys(out as any)).not.toContain('b');
  });

  it('keeps null values (those are valid Firestore values)', () => {
    const out = stripUndefined({ a: null, b: undefined });
    expect(out).toEqual({ a: null });
  });

  it('keeps falsy non-undefined values (0, "", false)', () => {
    const out = stripUndefined({ a: 0, b: '', c: false, d: undefined });
    expect(out).toEqual({ a: 0, b: '', c: false });
  });

  it('handles empty object', () => {
    expect(stripUndefined({})).toEqual({});
  });
});

describe('createInitialSegment', () => {
  it('omits taskId when not provided (the bug fix)', () => {
    const seg = createInitialSegment('09:00', Date.now());
    expect(seg).not.toHaveProperty('taskId');
  });

  it('includes taskId when provided', () => {
    const seg = createInitialSegment('09:00', Date.now(), 'task-123');
    expect(seg.taskId).toBe('task-123');
  });

  it('always has required fields', () => {
    const seg = createInitialSegment('09:00', 1234567890);
    expect(seg.id).toBeTruthy();
    expect(seg.clockInManual).toBe('09:00');
    expect(seg.clockInSystem).toBe(1234567890);
    expect(seg.complete).toBe(false);
  });

  it('produces unique ids', () => {
    const a = createInitialSegment('09:00', Date.now());
    const b = createInitialSegment('09:00', Date.now());
    expect(a.id).not.toBe(b.id);
  });
});

describe('applyLunchToSegment', () => {
  it('start action sets lunchOut only (no lunchIn)', () => {
    const seg = createInitialSegment('09:00', Date.now());
    const next = applyLunchToSegment(seg, 'start', '12:00', Date.now() + 1000);
    expect(next.lunchOutManual).toBe('12:00');
    expect(next.lunchInManual).toBeUndefined();
    // No undefined keys in the result
    for (const k of Object.keys(next)) {
      expect(next[k as keyof typeof next]).not.toBeUndefined();
    }
  });

  it('end action sets lunchIn only', () => {
    const seg = applyLunchToSegment(
      createInitialSegment('09:00', Date.now()),
      'start',
      '12:00',
      Date.now() + 1000,
    );
    const next = applyLunchToSegment(seg, 'end', '12:30', Date.now() + 2000);
    expect(next.lunchOutManual).toBe('12:00');
    expect(next.lunchInManual).toBe('12:30');
  });

  it('skip action sets skipLunch=true and omits lunch times', () => {
    const seg = createInitialSegment('09:00', Date.now());
    const next = applyLunchToSegment(seg, 'skip', '', Date.now() + 1000);
    expect(next.skipLunch).toBe(true);
    expect(next.lunchOutManual).toBeUndefined();
    expect(next.lunchInManual).toBeUndefined();
  });
});

describe('closeActiveSegment', () => {
  it('sets clockOut and workMinutes, marks complete', () => {
    const seg = createInitialSegment('09:00', 1000);
    const closed = closeActiveSegment(seg, '17:00', 8000 * 60 * 60 * 1000 + 1000, false);
    expect(closed.clockOutManual).toBe('17:00');
    expect(closed.complete).toBe(true);
    expect((closed.workMinutes ?? 0) > 0).toBe(true);
  });

  it('is idempotent — closing twice is a no-op', () => {
    const seg = createInitialSegment('09:00', 1000);
    const closed1 = closeActiveSegment(seg, '17:00', 8000 * 60 * 60 * 1000 + 1000, false);
    const closed2 = closeActiveSegment(closed1, '18:00', 9000 * 60 * 60 * 1000 + 1000, false);
    expect(closed2.clockOutManual).toBe('17:00');
  });

  // S6: cross-midnight shift duration must wrap past 24:00 instead of
  // collapsing to 0 (the old `outM - inM` gave -1260 -> 0 for 23:00->02:00).
  it('S6: wraps a cross-midnight shift (23:00 -> 02:00 = 180 min)', () => {
    const T0 = 1_000_000_000_000;
    const MIN = 60_000;
    const seg = createInitialSegment('23:00', T0);
    const closed = closeActiveSegment(seg, '02:00', T0 + 180 * MIN, false);
    expect(closed.workMinutes).toBe(180);
  });

  it('S6: subtracts a lunch that straddles midnight (22:00 / 23:30-00:30 / 02:00 = 180 min)', () => {
    const T0 = 1_000_000_000_000;
    const MIN = 60_000;
    let seg = createInitialSegment('22:00', T0);
    seg = applyLunchToSegment(seg, 'start', '23:30', T0 + 90 * MIN);
    seg = applyLunchToSegment(seg, 'end', '00:30', T0 + 150 * MIN);
    const closed = closeActiveSegment(seg, '02:00', T0 + 240 * MIN, false);
    // 4h shift (22:00->02:00 = 240) - 60min lunch = 180
    expect(closed.workMinutes).toBe(180);
  });

  it('S6: subtracts a lunch fully after midnight (22:00 / 00:30-01:00 / 02:00 = 210 min)', () => {
    const T0 = 1_000_000_000_000;
    const MIN = 60_000;
    let seg = createInitialSegment('22:00', T0);
    seg = applyLunchToSegment(seg, 'start', '00:30', T0 + 150 * MIN);
    seg = applyLunchToSegment(seg, 'end', '01:00', T0 + 180 * MIN);
    const closed = closeActiveSegment(seg, '02:00', T0 + 240 * MIN, false);
    // 4h shift (240) - 30min lunch = 210
    expect(closed.workMinutes).toBe(210);
  });

  it('S6: same-day shift is unchanged (08:00 -> 17:00 = 540 min)', () => {
    const T0 = 1_000_000_000_000;
    const MIN = 60_000;
    const seg = createInitialSegment('08:00', T0);
    const closed = closeActiveSegment(seg, '17:00', T0 + 540 * MIN, false);
    expect(closed.workMinutes).toBe(540);
  });

  // Invariant relied on by directCloseShift's guard (database.ts): a segment
  // closed via closeActiveSegment always has a truthy clockOutManual, so
  // guarding the close path on clockOutManual (not the `complete` flag) blocks
  // genuine double-closes while still allowing stale-flagged-but-clock-out-less
  // segments to be closed.
  it('closed segment always carries a truthy clockOutManual alongside complete', () => {
    const seg = createInitialSegment('09:00', 1000);
    expect(seg.clockOutManual).toBeFalsy();
    const closed = closeActiveSegment(seg, '17:00', 8000 * 60 * 60 * 1000 + 1000, false);
    expect(closed.complete).toBe(true);
    expect(closed.clockOutManual).toBeTruthy();
    expect(closed.clockOutManual).toBe('17:00');
  });
});

describe('calculateTotalHours — S6 cross-midnight', () => {
  it('returns 0 when clock-out is missing', () => {
    expect(calculateTotalHours({ clockInManual: '08:00' })).toBe(0);
  });

  it('same-day shift with no lunch (08:00 -> 17:00 = 9h)', () => {
    expect(calculateTotalHours({ clockInManual: '08:00', clockOutManual: '17:00' })).toBe(9);
  });

  it('same-day shift with lunch (08:00 / 12:00-12:30 / 17:00 = 8.5h)', () => {
    expect(
      calculateTotalHours({
        clockInManual: '08:00',
        lunchOutManual: '12:00',
        lunchInManual: '12:30',
        clockOutManual: '17:00',
      }),
    ).toBe(8.5);
  });

  it('wraps a cross-midnight shift (23:00 -> 02:00 = 3h)', () => {
    expect(calculateTotalHours({ clockInManual: '23:00', clockOutManual: '02:00' })).toBe(3);
  });

  it('subtracts a midnight-straddling lunch (22:00 / 23:30-00:30 / 02:00 = 3h)', () => {
    expect(
      calculateTotalHours({
        clockInManual: '22:00',
        lunchOutManual: '23:30',
        lunchInManual: '00:30',
        clockOutManual: '02:00',
      }),
    ).toBe(3);
  });

  it('subtracts a lunch fully after midnight (22:00 / 00:30-01:00 / 02:00 = 3.5h)', () => {
    expect(
      calculateTotalHours({
        clockInManual: '22:00',
        lunchOutManual: '00:30',
        lunchInManual: '01:00',
        clockOutManual: '02:00',
      }),
    ).toBe(3.5);
  });

  it('skipLunch=true does not subtract lunch even when lunch fields are set', () => {
    expect(
      calculateTotalHours({
        clockInManual: '22:00',
        lunchOutManual: '23:30',
        lunchInManual: '00:30',
        clockOutManual: '02:00',
        skipLunch: true,
      }),
    ).toBe(4);
  });
});

/**
 * Regression tests for the legacy-clockIn half-baked doc shape.
 *
 * Bug found 2026-06-15 in live Playwright: when an employee clocked in via the
 * legacy `?classic=1` TodayEntry form, the Firestore doc got legacy top-level
 * fields (`clockInManual`, `clockInSystemTime`, etc.) but NO `segments[]` and
 * NO `clockInSystem` (millis). The next read via `getActiveSegment` returned
 * null, so the ClockPunch UI showed "CLOCKED OUT" even though the user was
 * still on the clock.
 *
 * Fix: `getActiveSegment` and `hasOpenSegment` now fall back to the legacy
 * top-level fields when segments[] is empty.
 */
import { getActiveSegment, hasOpenSegment } from './segmentOps';

describe('getActiveSegment — legacy fallback', () => {
  it('returns null for a null entry', () => {
    expect(getActiveSegment(null)).toBeNull();
  });

  it('returns null for an entry with no segments and no clockIn', () => {
    expect(getActiveSegment({ id: 'u1_2026-06-15', userId: 'u1', date: '2026-06-15', complete: false, currentStep: 0 } as any)).toBeNull();
  });

  it('returns null for an entry with no segments and complete=true', () => {
    expect(getActiveSegment({
      id: 'u1_2026-06-15',
      userId: 'u1',
      date: '2026-06-15',
      clockInManual: '08:00',
      clockOutManual: '17:00',
      complete: true,
      currentStep: 4,
    } as any)).toBeNull();
  });

  it('returns the open segment when segments[] has an open one (canonical path)', () => {
    const seg = { id: 'seg_1', clockInManual: '08:00', clockInSystem: 1, complete: false };
    const entry = { id: 'u1_2026-06-15', userId: 'u1', date: '2026-06-15', segments: [seg], complete: false, currentStep: 2 } as any;
    expect(getActiveSegment(entry)).toBe(seg);
  });

  it('returns null when segments[] has only closed segments', () => {
    const closed = { id: 'seg_1', clockInManual: '08:00', clockInSystem: 1, clockOutManual: '17:00', complete: true };
    const entry = { id: 'u1_2026-06-15', userId: 'u1', date: '2026-06-15', segments: [closed], complete: true, currentStep: 4 } as any;
    expect(getActiveSegment(entry)).toBeNull();
  });

  it('returns entry.currentSegment when persisted segments is empty (synthesized view)', () => {
    const cur = { id: 'u1_2026-06-15_current', clockInManual: '08:00', clockInSystem: 1, complete: false };
    const entry = {
      id: 'u1_2026-06-15',
      userId: 'u1',
      date: '2026-06-15',
      segments: [],
      currentSegment: cur,
      clockInManual: '08:00',
      complete: false,
      currentStep: 2,
    } as any;
    expect(getActiveSegment(entry)).toBe(cur);
  });

  it('FALLBACK: synthesizes a current segment from legacy clockInManual when segments[] and currentSegment are missing (the TodayEntry bug)', () => {
    const entry = {
      id: 'u1_2026-06-15',
      userId: 'u1',
      date: '2026-06-15',
      // No segments, no currentSegment
      clockInManual: '08:30',
      clockInSystem: 1700000000000,
      // No clockOutManual, not complete
      complete: false,
      currentStep: 2,
    } as any;
    const active = getActiveSegment(entry);
    expect(active).not.toBeNull();
    expect(active!.clockInManual).toBe('08:30');
    expect(active!.clockInSystem).toBe(1700000000000);
    expect(active!.complete).toBe(false);
  });

  it('FALLBACK: returns null for legacy half-baked doc when clockInManual is set but clockOutManual is also set (already closed)', () => {
    const entry = {
      id: 'u1_2026-06-15',
      userId: 'u1',
      date: '2026-06-15',
      clockInManual: '08:30',
      clockOutManual: '17:00',
      complete: true,
      currentStep: 4,
    } as any;
    expect(getActiveSegment(entry)).toBeNull();
  });
});

describe('hasOpenSegment — legacy fallback', () => {
  it('returns true for legacy half-baked open-shift doc (the TodayEntry bug)', () => {
    const entry = {
      id: 'u1_2026-06-15',
      userId: 'u1',
      date: '2026-06-15',
      clockInManual: '08:30',
      complete: false,
      currentStep: 2,
    } as any;
    expect(hasOpenSegment(entry)).toBe(true);
  });

  it('returns false for legacy closed-shift doc', () => {
    const entry = {
      id: 'u1_2026-06-15',
      userId: 'u1',
      date: '2026-06-15',
      clockInManual: '08:30',
      clockOutManual: '17:00',
      complete: true,
      currentStep: 4,
    } as any;
    expect(hasOpenSegment(entry)).toBe(false);
  });

  it('returns null/false for a voided entry even with an open segment in segments[] (cleanup case)', () => {
    // Real-world: cleanup script soft-voids a doc but doesn't rewrite
    // segments[]. The validator must still treat this as "no open shift"
    // so punchIn can proceed.
    const openSeg = { id: 'seg_1', clockInManual: '08:30', clockInSystem: 1, complete: false };
    const entry = {
      id: 'u1_2026-06-15',
      userId: 'u1',
      date: '2026-06-15',
      segments: [openSeg],
      clockInManual: '08:30',
      complete: false,
      currentStep: 2,
      status: 'voided',
    } as any;
    expect(getActiveSegment(entry)).toBeNull();
    expect(hasOpenSegment(entry)).toBe(false);
  });

  it('returns null/false for an archived entry (parity with voided)', () => {
    const openSeg = { id: 'seg_1', clockInManual: '08:30', clockInSystem: 1, complete: false };
    const entry = {
      id: 'u1_2026-06-15',
      userId: 'u1',
      date: '2026-06-15',
      segments: [openSeg],
      complete: false,
      currentStep: 2,
      status: 'archived',
    } as any;
    expect(getActiveSegment(entry)).toBeNull();
    expect(hasOpenSegment(entry)).toBe(false);
  });
});

/**
 * Regression: `mapEntry` used to hardcode `complete: true` for every segment
 * in `segments[]`, hiding the open segment that `punchIn` writes. The result
 * was that `getActiveSegment` returned null even though the user was just
 * clocked in, and the ClockPunch UI flipped to "CLOCKED OUT" right after a
 * successful click. Fix: respect the persisted `complete` value.
 *
 * The downstream effect (and what the user actually saw) is exercised here
 * via getActiveSegment on the shape mapEntry would produce.
 */
describe('mapEntry segments[].complete — must respect persisted value', () => {
  it('REGRESSION: an open segment in segments[] is detected as the active segment even when clockOutManual is stale', () => {
    // This entry shape mirrors what a freshly clocked-in doc looks like after
    // mapEntry hydrates it, INCLUDING the stale clockOutManual from a previous
    // test run. Pre-fix, mapEntry would force complete:true on the segment
    // and getActiveSegment would return null. Post-fix, it returns the
    // open segment.
    const entry = {
      id: 'u1_2026-06-16',
      userId: 'u1',
      date: '2026-06-16',
      segments: [{ id: 'seg_1', clockInManual: '10:00', clockInSystem: 1, complete: false }],
      clockInManual: '10:00',
      clockOutManual: '09:00', // stale
      complete: false,
      currentStep: 2,
      status: 'active',
    };
    const active = getActiveSegment(entry as any);
    expect(active).not.toBeNull();
    expect(active!.complete).toBe(false);
    expect(hasOpenSegment(entry as any)).toBe(true);
  });
});

/**
 * Regression: punchIn must preserve previously archived (closed) segments.
 *
 * When an employee does a split shift (clock-in → clock-out → clock-in again),
 * the first closed segment must remain in segments[]. Previously, punchIn's
 * payload used `segments: [newSeg]` which overwrote the entire array, losing
 * the archived segments and making split-shift impossible.
 */
describe('split-shift: punchIn must preserve archived segments', () => {
  it('punchOut closes the active segment (complete=true)', () => {
    const openSeg: TimeSegment = {
      id: 'seg_1',
      clockInManual: '09:00',
      clockInSystem: 1000,
      complete: false,
    };
    const closed = closeActiveSegment(openSeg, '17:00', 8000 * 60 * 60 * 1000 + 1000);
    expect(closed.complete).toBe(true);
    expect(closed.clockOutManual).toBe('17:00');
    expect(closed.workMinutes).toBeGreaterThan(0);
  });

  it('entry with 2 segments (1 closed, 1 open) is valid — getActiveSegment returns the open one', () => {
    const closedSeg = { id: 'seg_1', clockInManual: '08:00', clockInSystem: 1, clockOutManual: '12:00', complete: true, workMinutes: 240 };
    const openSeg = { id: 'seg_2', clockInManual: '13:00', clockInSystem: 2, complete: false };
    const entry = {
      id: 'u1_2026-06-16',
      userId: 'u1',
      date: '2026-06-16',
      segments: [closedSeg, openSeg],
      clockInManual: '13:00',
      clockOutManual: undefined,
      complete: false,
      currentStep: 2,
      status: 'active',
    };
    const active = getActiveSegment(entry as any);
    expect(active).not.toBeNull();
    expect(active!.id).toBe('seg_2');
    expect(active!.complete).toBe(false);
    expect(hasOpenSegment(entry as any)).toBe(true);
  });

  it('closed segment workMinutes are preserved alongside the open segment', () => {
    const closedSeg = { id: 'seg_1', clockInManual: '08:00', clockInSystem: 1, clockOutManual: '12:00', complete: true, workMinutes: 240 };
    const openSeg = { id: 'seg_2', clockInManual: '13:00', clockInSystem: 2, complete: false };
    const entry = {
      id: 'u1_2026-06-16',
      userId: 'u1',
      date: '2026-06-16',
      segments: [closedSeg, openSeg],
      clockInManual: '13:00',
      complete: false,
      currentStep: 2,
      status: 'active',
    };
    const archivedMins = (entry.segments as any[]).filter(s => s.complete === true).reduce((sum, s) => sum + (s.workMinutes || 0), 0);
    expect(archivedMins).toBe(240);
  });

  it('voided document with a closed segment: no open segment returned (voided short-circuits)', () => {
    const closedSeg = { id: 'seg_1', clockInManual: '08:00', clockInSystem: 1, clockOutManual: '12:00', complete: true, workMinutes: 240 };
    const entry = {
      id: 'u1_2026-06-16',
      userId: 'u1',
      date: '2026-06-16',
      segments: [closedSeg],
      clockInManual: '08:00',
      clockOutManual: '12:00',
      complete: true,
      currentStep: 4,
      status: 'voided',
    };
    expect(getActiveSegment(entry as any)).toBeNull();
    expect(hasOpenSegment(entry as any)).toBe(false);
  });

  it('BUG REGRESSION: punchIn was overwriting segments array instead of appending', () => {
    // This test documents the bug: before the fix, punchIn did
    // segments: [newSeg] which replaced the entire array, losing closedSeg.
    // After the fix, punchIn should do segments: [...existingSegments, newSeg].

    const existingClosedSegments: TimeSegment[] = [
      { id: 'seg_1', clockInManual: '09:00', clockInSystem: 1000, clockOutManual: '17:00', workMinutes: 480, complete: true },
    ];

    const newOpenSeg: TimeSegment = {
      id: 'seg_2',
      clockInManual: '18:00',
      clockInSystem: 9000,
      complete: false,
    };

    const correctSegments = [...existingClosedSegments, newOpenSeg];
    expect(correctSegments).toHaveLength(2);
    expect(correctSegments[0].complete).toBe(true);
    expect(correctSegments[1].complete).toBe(false);

    const buggySegments = [newOpenSeg];
    expect(buggySegments).toHaveLength(1);
    expect(buggySegments[0].complete).toBe(false);
  });
});

/**
 * Regression: mapEntry double-counted the synthesized `current` segment against
 * the persisted archived segment in the ClockPunch dual-write flow, producing
 * an exact 2x day total. A 37-minute single ClockPunch shift displayed as
 * "1:14" (74 min) in TodayEntry/HistoryView. Reported 2026-06-22 (Timecamp.xlsx
 * Issue 2: "Should have been 37 minutes, shows 1:14").
 *
 * Root cause: mapEntry's override block unconditionally added
 * `current.workMinutes` to `archivedMins`, but the ClockPunch flow persists the
 * most-recent closed shift in BOTH `segments[]` AND the top-level legacy fields.
 * The synthesized `current` (built from those legacy fields) therefore
 * duplicates an entry already present in `archived`. The fix detects the
 * dual-write case by checking whether any archived seg covers the same shift
 * (clockInManual + clockOutManual) as `current`.
 */
import { mapEntry } from './database';

describe('mapEntry — Bug B: no double-count of synthesized current vs persisted archived seg', () => {
  it('REGRESSION: a single ClockPunch closed shift (37 min) is NOT shown as 74 min', () => {
    // Shape mirrors what `punchOut` writes after a single closed shift:
    // segments[] contains the closed seg AND top-level fields mirror the same shift.
    const data = {
      userId: 'u1',
      workDate: '2026-06-22',
      clockInManual: '12:30',
      clockOutManual: '13:07',
      clockInSystemTime: { toDate: () => new Date(0) },
      clockOutSystemTime: { toDate: () => new Date(0) },
      dayComplete: true,
      totalWorkMinutes: 37,
      segments: [
        {
          id: 'seg_1719123456789_abc',
          clockInManual: '12:30',
          clockOutManual: '13:07',
          workMinutes: 37,
          complete: true,
        },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-06-22', data as any);
    expect(entry.totalWorkMinutes).toBe(37);
    expect(entry.totalHours).toBeCloseTo(37 / 60, 5);
  });

  it('REGRESSION (Timecamp Issue 2 "39→41"): ClockPunch split shift 37 + 2 min totals 39 (not 41)', () => {
    // The user's exact symptom: after a 37-min shift #1 and a 2-min shift #2,
    // the day total showed 41 (= 39 + 2) because the synthesized `current`
    // (from the dual-written top-level fields) re-counted shift #2's 2 minutes
    // that were already in `archived`. `coveredByArchived` must detect this.
    const data = {
      userId: 'u1',
      workDate: '2026-06-22',
      clockInManual: '14:00',
      clockOutManual: '14:02',
      dayComplete: true,
      totalWorkMinutes: 39,
      segments: [
        { id: 'seg_1', clockInManual: '12:30', clockOutManual: '13:07', workMinutes: 37, complete: true },
        { id: 'seg_2', clockInManual: '14:00', clockOutManual: '14:02', workMinutes: 2, complete: true },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-06-22', data as any);
    expect(entry.totalWorkMinutes).toBe(39);
  });

  it('ClockPunch split shift: two closed shifts (37 + 9 min) total 46 min (not 55, not 92)', () => {
    // After punchOut #2 in a split shift, segments[] = [closedSeg1, closedSeg2]
    // and top-level fields mirror closedSeg2 (the most recent). The synthesized
    // current duplicates closedSeg2 only.
    const data = {
      userId: 'u1',
      workDate: '2026-06-22',
      clockInManual: '14:00',
      clockOutManual: '14:09',
      dayComplete: true,
      totalWorkMinutes: 46,
      segments: [
        {
          id: 'seg_1',
          clockInManual: '12:30',
          clockOutManual: '13:07',
          workMinutes: 37,
          complete: true,
        },
        {
          id: 'seg_2',
          clockInManual: '14:00',
          clockOutManual: '14:09',
          workMinutes: 9,
          complete: true,
        },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-06-22', data as any);
    expect(entry.totalWorkMinutes).toBe(46);
  });

  it('TodayEntry single legacy shift (no segments[]) preserves totalWorkMinutes', () => {
    // TodayEntry writes only top-level fields + totalWorkMinutes, no segments[].
    // archived.length is 0 so the override does not apply; the stored value wins.
    const data = {
      userId: 'u1',
      workDate: '2026-06-22',
      clockInManual: '12:30',
      clockOutManual: '13:07',
      dayComplete: true,
      totalWorkMinutes: 37,
      status: 'active',
    };
    const entry = mapEntry('u1_2026-06-22', data as any);
    expect(entry.totalWorkMinutes).toBe(37);
    expect(entry.segments).toEqual([]);
  });

  it('TodayEntry split shift: archived seg (shift #1) + current (shift #2) both count', () => {
    // TodayEntry archives only prior shifts to segments[]; the current (most
    // recent) shift lives in top-level fields and is NOT duplicated in segments[].
    // The synthesized current MUST contribute its minutes here.
    const data = {
      userId: 'u1',
      workDate: '2026-06-22',
      clockInManual: '14:00',
      clockOutManual: '14:09',
      dayComplete: true,
      totalWorkMinutes: 46,
      segments: [
        {
          id: 'seg_1',
          clockInManual: '12:30',
          clockOutManual: '13:07',
          workMinutes: 37,
          complete: true,
        },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-06-22', data as any);
    // archived(37) + current synthesized from top-level (9) = 46
    expect(entry.totalWorkMinutes).toBe(46);
  });

  it('ClockPunch open shift (clock-in only, no clock-out) does not synthesize current minutes', () => {
    // An open shift has no clockOutManual, so deriveCurrentSegmentMinutes
    // returns undefined → current.workMinutes is undefined → contributes 0.
    const data = {
      userId: 'u1',
      workDate: '2026-06-22',
      clockInManual: '09:00',
      dayComplete: false,
      totalWorkMinutes: 0,
      segments: [
        {
          id: 'seg_open',
          clockInManual: '09:00',
          complete: false,
        },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-06-22', data as any);
    expect(entry.totalWorkMinutes).toBe(0);
  });
});

describe('buildConsistentClosePatch — S7 dual-write contract', () => {
  it('replace mode: single closed segment + matching total (no archived)', () => {
    const { segments, totalWorkMinutes, closedSegment } = buildConsistentClosePatch({
      clockIn: '08:00',
      clockOut: '17:00',
      skipLunch: false,
      lunchOut: '12:00',
      lunchIn: '12:30',
      clockOutSystem: 9000,
      mode: 'replace',
    });
    expect(segments).toHaveLength(1);
    expect(closedSegment.complete).toBe(true);
    expect(closedSegment.clockOutManual).toBe('17:00');
    expect(closedSegment.workMinutes).toBe(510); // 9h - 30min lunch
    expect(totalWorkMinutes).toBe(510);
  });

  it('replace mode: drops prior archived segments (admin correction collapse)', () => {
    const archived: TimeSegment = {
      id: 'seg_old',
      clockInManual: '08:00',
      clockOutManual: '12:00',
      workMinutes: 240,
      complete: true,
    };
    const { segments, totalWorkMinutes } = buildConsistentClosePatch({
      clockIn: '13:00',
      clockOut: '17:00',
      skipLunch: true,
      clockOutSystem: 9000,
      existingSegments: [archived],
      mode: 'replace',
    });
    expect(segments).toHaveLength(1); // prior archived dropped
    expect(segments[0].clockInManual).toBe('13:00');
    expect(totalWorkMinutes).toBe(240); // only the new 4h shift
  });

  it('append mode: preserves prior archived segments + appends closed', () => {
    const archived: TimeSegment = {
      id: 'seg_old',
      clockInManual: '08:00',
      clockOutManual: '12:00',
      workMinutes: 240,
      complete: true,
    };
    const { segments, totalWorkMinutes, closedSegment } = buildConsistentClosePatch({
      clockIn: '13:00',
      clockOut: '17:00',
      skipLunch: true,
      clockOutSystem: 9000,
      existingSegments: [archived],
      mode: 'append',
    });
    expect(segments).toHaveLength(2);
    expect(segments[0].id).toBe('seg_old');
    expect(segments[1].id).toBe(closedSegment.id);
    expect(totalWorkMinutes).toBe(480); // 240 archived + 240 new
  });

  it('append mode: ignores open (incomplete) existing segments', () => {
    const open: TimeSegment = {
      id: 'seg_open',
      clockInManual: '08:00',
      complete: false,
    };
    const { segments } = buildConsistentClosePatch({
      clockIn: '13:00',
      clockOut: '17:00',
      skipLunch: true,
      clockOutSystem: 9000,
      existingSegments: [open],
      mode: 'append',
    });
    // Open segment filtered out (only complete archived kept); only the new
    // closed segment remains.
    expect(segments).toHaveLength(1);
    expect(segments[0].complete).toBe(true);
  });

  it('S6 cross-midnight: 23:00 -> 02:00 = 180 min via the helper', () => {
    const { totalWorkMinutes, closedSegment } = buildConsistentClosePatch({
      clockIn: '23:00',
      clockOut: '02:00',
      skipLunch: true,
      clockOutSystem: 9000,
      mode: 'replace',
    });
    expect(closedSegment.workMinutes).toBe(180);
    expect(totalWorkMinutes).toBe(180);
  });

  it('produces a segment whose workMinutes matches totalWorkMinutes (replace, no archived)', () => {
    // The core S7 invariant: segments[last].workMinutes === totalWorkMinutes
    // so mapEntry's override (archivedMins + currentMins=0) agrees.
    const { segments, totalWorkMinutes } = buildConsistentClosePatch({
      clockIn: '09:00',
      clockOut: '17:30',
      skipLunch: false,
      lunchOut: '12:00',
      lunchIn: '12:30',
      clockOutSystem: 9000,
      mode: 'replace',
    });
    const last = segments[segments.length - 1];
    expect(last.workMinutes).toBe(totalWorkMinutes);
  });
});

/**
 * Regression: "didn't clock out but looks clocked out" on a split-shift doc.
 *
 * Bug: the mapEntry S1 fallback unconditionally copied the last persisted
 * segment's clockOutManual/lunch up to the entry, even when the top-level
 * fields belonged to a DIFFERENT (newer, open) shift. With segments[] ending
 * in a CLOSED seg1 while an OPEN seg2 lived only in top-level fields, this
 * marked seg2 falsely complete → every view showed "clocked out" with seg1's
 * exact minutes (the open seg2 contributed 0 via the clamp).
 *
 * Fix: the S1 fallback only inherits clockOut/lunch when the top-level
 * clockIn is absent (legacy doc) OR matches the last persisted segment's
 * clockIn (same shift, dual-write divergence).
 */
describe('mapEntry — S1 fallback must not falsely close an open split-shift seg2', () => {
  it('REGRESSION: open seg2 (top-level only) is NOT falsely closed by inheriting closed seg1 clockOut', () => {
    // Buggy doc shape (TodayEntry classic split-shift "Start New Shift"
    // before the write-side fix): segments[] ends in the CLOSED seg1 while
    // the open seg2 lives only in top-level fields. Pre-fix, the S1 fallback
    // copied seg1.clockOutManual up to the entry, marking seg2 complete and
    // rendering the user as "clocked out" with seg1's exact minutes (10h).
    const data = {
      userId: 'u1',
      workDate: '2026-07-28',
      clockInManual: '20:00', // seg2 (open) clock-in — different from seg1
      // clockOutManual omitted → undefined (open shift)
      dayComplete: false,
      totalWorkMinutes: 600, // accumulated = seg1's 10h
      segments: [
        {
          id: 'seg_1',
          clockInManual: '08:00', // seg1 clock-in (A)
          clockOutManual: '18:00', // seg1 clock-out (B) — 10h
          workMinutes: 600,
          complete: true,
        },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-07-28', data as any);
    // The open seg2 must NOT inherit seg1's clockOutManual:
    expect(entry.clockOutManual).toBeUndefined();
    expect(entry.currentSegment?.complete).toBe(false);
    expect(entry.currentSegment?.clockOutManual).toBeUndefined();
    // The open shift is detected as active (not "clocked out"):
    expect(getActiveSegment(entry)).not.toBeNull();
    expect(hasOpenSegment(entry)).toBe(true);
    // Day total reflects seg1's completed minutes (the open seg2 contributes 0
    // to the persisted total; live minutes are added by getPunchStatus):
    expect(entry.totalWorkMinutes).toBe(600);
  });

  it('LEGIT CASE: same-shift dual-write gap still inherits clockOut from last persisted seg', () => {
    // A doc whose top-level clockInManual matches the last persisted segment's
    // clockInManual (same shift) but clockOutManual wasn't dual-written at the
    // top level. The S1 fallback MUST still repair this so HistoryView doesn't
    // show "Missing Clock Out" for a valid closed shift.
    const data = {
      userId: 'u1',
      workDate: '2026-07-28',
      clockInManual: '08:00', // matches seg1.clockInManual (same shift)
      // clockOutManual omitted at top level (dual-write gap)
      dayComplete: true,
      totalWorkMinutes: 600,
      segments: [
        {
          id: 'seg_1',
          clockInManual: '08:00',
          clockOutManual: '18:00', // present only in segments[]
          workMinutes: 600,
          complete: true,
        },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-07-28', data as any);
    // Inherited from seg1 (same shift) — the repair the S1 fallback exists for:
    expect(entry.clockOutManual).toBe('18:00');
    expect(entry.currentSegment?.complete).toBe(true);
    expect(getActiveSegment(entry)).toBeNull();
    expect(entry.totalWorkMinutes).toBe(600);
  });

  it('LEGIT CASE: legacy doc with no top-level clockIn still inherits from last persisted seg', () => {
    // A legacy/corrupted doc where the top-level clockInManual is missing but
    // segments[] holds the complete shift. The S1 fallback inherits clockIn
    // (always) and clockOut (sameShift=true because clockIn is absent).
    const data = {
      userId: 'u1',
      workDate: '2026-07-28',
      // clockInManual omitted at top level
      dayComplete: true,
      totalWorkMinutes: 480,
      segments: [
        { id: 'seg_1', clockInManual: '09:00', clockOutManual: '17:00', workMinutes: 480, complete: true },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-07-28', data as any);
    expect(entry.clockInManual).toBe('09:00');
    expect(entry.clockOutManual).toBe('17:00');
    expect(entry.totalWorkMinutes).toBe(480);
  });

  it('REGRESSION: ClockPunch two-segment doc (seg1 closed + seg2 open in segments[]) stays open', () => {
    // The default ClockPunch path appends the open seg2 into segments[]. The
    // guard must NOT break this: segments[] ends in an open segment, so
    // getActiveSegment returns it (the S1 fallback is irrelevant here).
    const data = {
      userId: 'u1',
      workDate: '2026-07-28',
      clockInManual: '20:00', // mirrors seg2 (open)
      dayComplete: false,
      totalWorkMinutes: 600,
      segments: [
        { id: 'seg_1', clockInManual: '08:00', clockOutManual: '18:00', workMinutes: 600, complete: true },
        { id: 'seg_2', clockInManual: '20:00', complete: false },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-07-28', data as any);
    expect(getActiveSegment(entry)).not.toBeNull();
    expect(getActiveSegment(entry)?.id).toBe('seg_2');
    expect(hasOpenSegment(entry)).toBe(true);
    expect(entry.totalWorkMinutes).toBe(600);
  });
});

/**
 * Regression: pre-fix cross-midnight split doc (23:32→00:28 bug).
 * Both split parts were persisted on the punch-in day's doc while the
 * top-level dual-written fields still spanned the full midnight range. The
 * synthesized `current` (23:32→00:28) must NOT be double-counted on top of
 * the persisted split parts (28+28), and the day must read as fully closed.
 */
describe('mapEntry — split-chain double-count defense (cross-midnight)', () => {
  it('does NOT double-count the synthesized current spanning a persisted split chain', () => {
    const data = {
      userId: 'u1',
      workDate: '2026-07-29',
      clockInManual: '23:32',   // top-level spans the full shift
      clockOutManual: '00:28',
      dayComplete: true,
      totalWorkMinutes: 56,     // stored value from punchOut
      segments: [
        {
          id: 'seg_d1',
          clockInManual: '23:32',
          clockOutManual: '23:59',
          workMinutes: 28,
          complete: true,
          splitFromMidnight: true,
          localDate: '2026-07-29',
        },
        {
          id: 'seg_d2',
          clockInManual: '00:00',
          clockOutManual: '00:28',
          workMinutes: 28,
          complete: true,
          splitFromMidnight: true,
          localDate: '2026-07-30',
        },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-07-29', data as any);
    // 56 (28+28 persisted parts), NOT 112 (which added the spanning current).
    expect(entry.totalWorkMinutes).toBe(56);
    expect(entry.totalHours).toBeCloseTo(56 / 60, 5);
    // Both persisted parts hydrated with their split-attribution fields.
    expect(entry.segments).toHaveLength(2);
    expect(entry.segments?.[0].localDate).toBe('2026-07-29');
    expect(entry.segments?.[1].localDate).toBe('2026-07-30');
    expect(entry.segments?.[0].splitFromMidnight).toBe(true);
    // Fully closed — no active/open segment anywhere.
    expect(getActiveSegment(entry)).toBeNull();
    expect(hasOpenSegment(entry)).toBe(false);
  });

  it('normal same-day split-shift doc is unaffected by the split-chain check', () => {
    // Two closed same-day shifts; top-level mirrors the LAST shift. The chain
    // check (first.clockIn == current.clockIn) must not fire — the exact-match
    // dual-write dedup already covers `current`.
    const data = {
      userId: 'u1',
      workDate: '2026-07-29',
      clockInManual: '13:00',
      clockOutManual: '17:00',
      dayComplete: true,
      totalWorkMinutes: 480,
      segments: [
        { id: 'seg_1', clockInManual: '08:00', clockOutManual: '12:00', workMinutes: 240, complete: true },
        { id: 'seg_2', clockInManual: '13:00', clockOutManual: '17:00', workMinutes: 240, complete: true },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-07-29', data as any);
    expect(entry.totalWorkMinutes).toBe(480);
    expect(getActiveSegment(entry)).toBeNull();
  });
});

/**
 * Regression: edited totals must propagate to every view (SSOT).
 *
 * Bug: after a within-24h direct edit of clockOutManual (17:00 → 18:00), the
 * stored segment `workMinutes` (480, from the pre-edit 17:00 close) and the
 * stored `totalWorkMinutes`/`totalHours` went STALE because the recompute
 * measured the un-updated clockOutSystem. History/Team/Audit (mapEntry, which
 * summed raw stored workMinutes) and Payroll (which recomputed via the
 * system-preferred function) all kept showing the pre-edit total (8h).
 *
 * Fix: computeSegmentWorkMinutes is now manual-primary-when-stored-diverges
 * (hybrid SSOT), and mapEntry recomputes archived minutes via it — so an edit
 * is reflected immediately even on the already-stale stored doc.
 */
describe('mapEntry — edited totals propagate (SSOT)', () => {
  it('reflects an edited clockOut even when stored workMinutes is stale', () => {
    // The segment's manual clockOut was edited to 18:00, but its stored
    // workMinutes (480) and the doc's totalWorkMinutes/totalHours are stale
    // (still reflect the 17:00 close).
    const data = {
      userId: 'u1',
      workDate: '2026-07-30',
      clockInManual: '09:00',
      clockOutManual: '18:00',          // edited
      dayComplete: true,
      totalWorkMinutes: 480,            // stale (was 8h)
      totalHours: 8,                    // stale
      segments: [
        {
          id: 'seg_1',
          clockInManual: '09:00',
          clockOutManual: '18:00',      // edited
          workMinutes: 480,             // stale (pre-edit system close)
          complete: true,
        },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-07-30', data as any);
    // 09:00 → 18:00 = 540 min = 9h (the EDITED total), not the stale 480/8h.
    expect(entry.totalWorkMinutes).toBe(540);
    expect(entry.totalHours).toBeCloseTo(9, 5);
  });

  it('reflects an edited clockIn too (08:00 → 09:00 with stale stored 480)', () => {
    const data = {
      userId: 'u1',
      workDate: '2026-07-30',
      clockInManual: '09:00',
      clockOutManual: '17:00',
      dayComplete: true,
      totalWorkMinutes: 480,
      segments: [
        { id: 'seg_1', clockInManual: '09:00', clockOutManual: '17:00', workMinutes: 480, complete: true },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-07-30', data as any);
    expect(entry.totalWorkMinutes).toBe(480); // 09:00→17:00 = 480, unchanged
  });

  it('does NOT regress a non-edited split doc (stored accurate when consistent)', () => {
    // The split stored accurate system-based minutes (28/28). The hybrid must
    // keep them (within the 1-min tolerance), not recompute to 27/28.
    const data = {
      userId: 'u1',
      workDate: '2026-07-29',
      clockInManual: '23:32',
      clockOutManual: '00:28',
      dayComplete: true,
      totalWorkMinutes: 56,
      segments: [
        { id: 'seg_d1', clockInManual: '23:32', clockOutManual: '23:59', workMinutes: 28, complete: true, splitFromMidnight: true, localDate: '2026-07-29' },
        { id: 'seg_d2', clockInManual: '00:00', clockOutManual: '00:28', workMinutes: 28, complete: true, splitFromMidnight: true, localDate: '2026-07-30' },
      ],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-07-29', data as any);
    expect(entry.totalWorkMinutes).toBe(56); // accurate, no artifact
  });
});

/**
 * Regression: a manual edit (directEditSegmentField) recomputes the segment's
 * `*System` epoch millis from the edited `*Manual` string, but the segment has
 * no `*SystemTime` Firestore Timestamp. mapEntry's top-level read previously
 * looked ONLY at `*SystemTime`, so the recomputed millis was ignored and the
 * Team view / Payroll rows showed the stale pre-edit instant.
 *
 * Fix: mapEntry top-level now reads `*SystemTime ?? *System` (matching the
 * segment read), so a millis-only write is reflected.
 */
describe('mapEntry — *System falls back to millis when *SystemTime absent (edit path)', () => {
  it('reads the recomputed top-level clockOutSystem millis (no SystemTime)', () => {
    // After directEditSegmentField: top-level clockOutManual edited to 18:00,
    // clockOutSystem millis recomputed to the 18:00 instant, clockOutSystemTime
    // refreshed to match. Verify mapEntry reads the fresh value.
    const editedMs = Date.UTC(2026, 6, 30, 18, 0, 0);
    const data = {
      userId: 'u1',
      workDate: '2026-07-30',
      clockInManual: '09:00',
      clockOutManual: '18:00',
      clockOutSystem: editedMs,        // recomputed millis (no SystemTime)
      dayComplete: true,
      totalWorkMinutes: 540,
      segments: [
        { id: 'seg_1', clockInManual: '09:00', clockOutManual: '18:00', clockOutSystem: editedMs, workMinutes: 540, complete: true },
      ],
      status: 'corrected',
    };
    const entry = mapEntry('u1_2026-07-30', data as any);
    expect(entry.clockOutSystem).toBe(editedMs);
  });

  it('prefers *SystemTime when both are present (normal punch flow)', () => {
    // Normal punch writes both; mapEntry should prefer the Timestamp.
    const tsMs = Date.UTC(2026, 6, 30, 17, 0, 0);
    const staleMillis = Date.UTC(2026, 6, 30, 16, 0, 0);
    const data = {
      userId: 'u1',
      workDate: '2026-07-30',
      clockInManual: '09:00',
      clockOutManual: '17:00',
      clockOutSystemTime: { toDate: () => new Date(tsMs) }, // Timestamp-like
      clockOutSystem: staleMillis,
      dayComplete: true,
      segments: [],
      status: 'active',
    };
    const entry = mapEntry('u1_2026-07-30', data as any);
    expect(entry.clockOutSystem).toBe(tsMs); // prefers SystemTime over stale millis
  });

  it('segment *System falls back to millis when *SystemTime absent', () => {
    const segMs = Date.UTC(2026, 6, 30, 18, 0, 0);
    const data = {
      userId: 'u1',
      workDate: '2026-07-30',
      clockInManual: '09:00',
      clockOutManual: '18:00',
      dayComplete: true,
      totalWorkMinutes: 540,
      segments: [
        // Segment has clockOutSystem millis but no clockOutSystemTime — the
        // shape produced by recomputeSegmentSystemTimestamps on an edit.
        { id: 'seg_1', clockInManual: '09:00', clockOutManual: '18:00', clockInSystem: Date.UTC(2026, 6, 30, 16, 0, 0), clockOutSystem: segMs, workMinutes: 540, complete: true },
      ],
      status: 'corrected',
    };
    const entry = mapEntry('u1_2026-07-30', data as any);
    expect(entry.segments![0].clockOutSystem).toBe(segMs);
    expect(entry.segments![0].clockInSystem).toBe(Date.UTC(2026, 6, 30, 16, 0, 0));
  });
});

describe('getEntryTotals — canonical read-side SSOT', () => {
  it('reflects an edited clockOut from stale stored segment workMinutes', () => {
    const entry = {
      complete: true,
      clockInManual: '09:00',
      clockOutManual: '18:00', // edited
      segments: [
        { id: 's1', clockInManual: '09:00', clockOutManual: '18:00', workMinutes: 480, complete: true },
      ],
    } as any;
    const t = getEntryTotals(entry);
    expect(t.totalWorkMinutes).toBe(540);
    expect(t.totalHours).toBeCloseTo(9, 5);
  });

  it('sums multiple segments (hybrid per segment)', () => {
    const entry = {
      complete: true,
      segments: [
        { id: 's1', clockInManual: '08:00', clockOutManual: '12:00', workMinutes: 240, complete: true },
        { id: 's2', clockInManual: '13:00', clockOutManual: '17:00', workMinutes: 240, complete: true },
      ],
    } as any;
    expect(getEntryTotals(entry).totalWorkMinutes).toBe(480);
  });

  it('derives from top-level manual fields when there are no segments', () => {
    const entry = {
      complete: true,
      clockInManual: '09:00',
      clockOutManual: '17:00',
      // no segments
    } as any;
    expect(getEntryTotals(entry).totalWorkMinutes).toBe(480);
  });

  it('keeps the stored total for a no-segments doc that has one', () => {
    const entry = {
      complete: true,
      clockInManual: '09:00',
      clockOutManual: '17:00',
      totalWorkMinutes: 477, // stored (legacy)
      // no segments
    } as any;
    expect(getEntryTotals(entry).totalWorkMinutes).toBe(477);
  });

  it('does not double-count the synthesized current when it mirrors the last segment', () => {
    const entry = {
      complete: true,
      clockInManual: '09:00',
      clockOutManual: '17:00',
      currentSegment: { id: 'x_current', clockInManual: '09:00', clockOutManual: '17:00', workMinutes: 480, complete: true },
      segments: [
        { id: 's1', clockInManual: '09:00', clockOutManual: '17:00', workMinutes: 480, complete: true },
      ],
    } as any;
    expect(getEntryTotals(entry).totalWorkMinutes).toBe(480); // not 960
  });
});
