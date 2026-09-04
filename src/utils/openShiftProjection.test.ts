/**
 * Tests for the Analytics open-shift projection (utils/openShiftProjection.ts).
 *
 * Verifies the in-memory virtual closure: open shifts accumulate time up to
 * `now`, lunches in progress are deducted, legacy top-level-only open shifts
 * are materialized, inputs are never mutated, and nothing is written anywhere
 * (the module has no firebase dependency at all).
 */
import type { DocumentData } from 'firebase/firestore';
import { projectOpenShiftsAt } from './openShiftProjection';
import { calculateBiweeklyOvertimeTotals, type OvertimeEntry } from './overtimeCalculations';

// Fixed "now" for deterministic tests.
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0); // 2026-08-24T12:00:00Z
const HOUR = 60 * 60 * 1000;

function openSeg(overrides: Record<string, unknown> = {}) {
  return {
    id: 'seg_1',
    clockInManual: '08:00',
    complete: false,
    ...overrides,
  };
}

describe('projectOpenShiftsAt', () => {
  it('virtually closes an open segment at now and accumulates the span', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({ clockInSystem: NOW - 2 * HOUR })],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);

    expect(out.projectedOpen).toBe(true);
    expect(out.projectedNow).toBe(NOW);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].projectedClosed).toBe(true);
    expect(out.segments[0].clockOutSystem).toBe(NOW);
    expect(out.segments[0].complete).toBe(true);
    expect(out.totalWorkMinutes).toBe(120);
    expect(out.totalHours).toBe(2);
    // OT buckets cleared so the engine recomputes from projected totals.
    expect(out.regularMinutes).toBeUndefined();
    expect(out.otMinutes).toBeUndefined();
    expect(out.doubleTimeMinutes).toBeUndefined();

    // Input doc/segment are NOT mutated (read-side only).
    expect(doc.projectedOpen).toBeUndefined();
    expect(doc.segments[0].clockOutSystem).toBeUndefined();
    expect(doc.segments[0].complete).toBe(false);
  });

  it('ends an in-progress lunch at the virtual close so it is deducted', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({
        clockInSystem: NOW - 4 * HOUR,
        lunchOutSystem: NOW - 30 * 60 * 1000, // went to lunch 30 min ago
      })],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    expect(out.projectedOpen).toBe(true);
    // 4h gross − 30min open lunch = 210 min
    expect(out.totalWorkMinutes).toBe(210);
    expect(out.segments[0].lunchInSystem).toBe(NOW);
  });

  it('deducts the ACTUAL elapsed lunch when under the max-open threshold', () => {
    // Cron hasn't fired yet (112 min < 150 max): the lunch is legitimately
    // still open, so the projection deducts the real elapsed duration.
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({
        clockInSystem: NOW - 8 * HOUR,
        lunchOutSystem: NOW - 112 * 60 * 1000, // lunch started 112 min ago
      })],
    };
    const [out] = projectOpenShiftsAt([doc], NOW, {
      lunchMaxMinutes: 150,
      lunchRecordedMinutes: 60,
    });
    expect(out.projectedOpen).toBe(true);
    // 8h gross − 112min actual lunch = 368 min
    expect(out.totalWorkMinutes).toBe(368);
    // lunchInSystem ends at nowMs (actual elapsed), NOT capped
    expect(out.segments[0].lunchInSystem).toBe(NOW);
  });

  it('caps an over-threshold in-progress lunch to the recorded minutes', () => {
    // Reproduces the ~2h discrepancy: two employees clock in 14 min apart,
    // but one has a forgotten lunch-start past the 150-min max. The cron
    // would stamp lunchIn = lunchOut + 60min — the projection mirrors that.
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({
        clockInSystem: NOW - 8 * HOUR,        // clocked in 8h ago
        lunchOutSystem: NOW - 3 * HOUR,        // started lunch 3h ago (>= 150 max), never ended
      })],
    };
    const [out] = projectOpenShiftsAt([doc], NOW, {
      lunchMaxMinutes: 150,
      lunchRecordedMinutes: 60,
    });
    expect(out.projectedOpen).toBe(true);
    // 8h gross − 60min capped lunch = 420 min (not 8h − 3h = 300 min)
    expect(out.totalWorkMinutes).toBe(420);
    // lunchInSystem is capped at loMs + 60min, NOT nowMs
    const loMs = NOW - 3 * HOUR;
    expect(out.segments[0].lunchInSystem).toBe(loMs + 60 * 60 * 1000);
  });

  it('uses the default guardrail limits (120 max / 60 recorded) when no options are passed', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({
        clockInSystem: NOW - 8 * HOUR,
        lunchOutSystem: NOW - 3 * HOUR, // 180 min elapsed >= 120 default max
      })],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    // 8h gross − 60min recorded cap = 420 min
    expect(out.totalWorkMinutes).toBe(420);
    const loMs = NOW - 3 * HOUR;
    expect(out.segments[0].lunchInSystem).toBe(loMs + 60 * 60 * 1000);
  });

  it('boundary: lunch elapsed exactly at the max threshold is capped', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({
        clockInSystem: NOW - 8 * HOUR,
        lunchOutSystem: NOW - 150 * 60 * 1000, // exactly 150 min elapsed
      })],
    };
    const [out] = projectOpenShiftsAt([doc], NOW, {
      lunchMaxMinutes: 150,
      lunchRecordedMinutes: 60,
    });
    // elapsed >= max → capped to 60 recorded minutes: 480 − 60 = 420
    expect(out.totalWorkMinutes).toBe(420);
  });

  it('two employees clocked in 14 min apart project consistently (over-threshold lunch)', () => {
    // Mutlu: clocked in 8:05 AM, no lunch
    const mutlu: DocumentData = {
      id: 'mutlu_2026-08-24',
      userId: 'mutlu',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({ clockInSystem: NOW - 8 * HOUR - 14 * 60 * 1000 })],
    };
    // Gary: clocked in 8:19 AM (14 min later), forgot to end lunch 3h ago
    const gary: DocumentData = {
      id: 'gary_2026-08-24',
      userId: 'gary',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({
        clockInSystem: NOW - 8 * HOUR,
        lunchOutSystem: NOW - 3 * HOUR,
      })],
    };
    const opts = { lunchMaxMinutes: 150, lunchRecordedMinutes: 60 };
    const [mOut, gOut] = projectOpenShiftsAt([mutlu, gary], NOW, opts);
    // Mutlu: 8h14m gross, no lunch = 494 min
    expect(mOut.totalWorkMinutes).toBe(494);
    // Gary: 8h gross − 60min capped lunch = 420 min
    expect(gOut.totalWorkMinutes).toBe(420);
    // Difference: 494 − 420 = 74 min ≈ 14 min clock-in delta + 60 min lunch
    // (without the cap, Gary would show 8h − 3h = 300 min, a 194-min gap)
  });

  it('keeps a completed lunch as-is (not extended to now)', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({
        clockInSystem: NOW - 4 * HOUR,
        lunchOutSystem: NOW - 2 * HOUR,
        lunchInSystem: NOW - 90 * 60 * 1000, // 30-minute lunch, already ended
      })],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    expect(out.totalWorkMinutes).toBe(240 - 30);
  });

  it('skipLunch open shifts project without any lunch deduction', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({ clockInSystem: NOW - 3 * HOUR, skipLunch: true })],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    expect(out.totalWorkMinutes).toBe(180);
  });

  it('materializes a legacy top-level-only open shift as a projected segment', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      clockInManual: '09:00',
      clockInSystem: NOW - 3 * HOUR,
      segments: [],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    expect(out.projectedOpen).toBe(true);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].id).toContain('_virtual_now');
    expect(out.totalWorkMinutes).toBe(180);
  });

  it('S1 guard: top-level clock-in mirroring the last CLOSED segment is not a new open shift', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      clockInManual: '08:00',
      // No top-level clockOutManual — but the persisted segment for the same
      // shift is closed, so the root fields merely mirror it.
      segments: [{
        id: 'seg_1',
        clockInManual: '08:00',
        clockOutManual: '12:00',
        clockInSystem: NOW - 5 * HOUR,
        clockOutSystem: NOW - 1 * HOUR,
        complete: true,
        workMinutes: 240,
      }],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    expect(out).toBe(doc); // returned by reference, unprojected
  });

  it('projects a NEWER top-level open shift even when closed segments exist', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      clockInManual: '13:00', // different shift than the closed 08:00 segment
      clockInSystem: NOW - 2 * HOUR,
      segments: [{
        id: 'seg_1',
        clockInManual: '08:00',
        clockOutManual: '12:00',
        clockInSystem: NOW - 6 * HOUR,
        clockOutSystem: NOW - 3 * HOUR,
        complete: true,
        workMinutes: 240,
      }],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    expect(out.projectedOpen).toBe(true);
    expect(out.segments).toHaveLength(2);
    expect(out.totalWorkMinutes).toBe(240 + 120);
  });

  it('accepts legacy Timestamp-like clockInSystemTime values', () => {
    const fakeTimestamp = { toMillis: () => NOW - 3 * HOUR, toDate: () => new Date(NOW - 3 * HOUR) };
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({ clockInSystemTime: fakeTimestamp })],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    expect(out.projectedOpen).toBe(true);
    expect(out.totalWorkMinutes).toBe(180);
  });

  it('leaves fully closed days untouched (returned by reference)', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-23',
      userId: 'u1',
      workDate: '2026-08-23',
      dayComplete: true,
      clockInManual: '08:00',
      clockOutManual: '17:00',
      segments: [{
        id: 'seg_1',
        clockInManual: '08:00',
        clockOutManual: '17:00',
        complete: true,
        workMinutes: 480,
      }],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    expect(out).toBe(doc);
  });

  it('never projects voided or archived docs', () => {
    const mk = (status: string) => ({
      id: `u1_${status}`,
      userId: 'u1',
      workDate: '2026-08-24',
      status,
      dayComplete: false,
      segments: [openSeg({ clockInSystem: NOW - 2 * HOUR })],
    });
    const voided = mk('voided');
    const archived = mk('archived');
    const [outV, outA] = projectOpenShiftsAt([voided, archived], NOW);
    expect(outV).toBe(voided);
    expect(outA).toBe(archived);
  });

  it('leaves segments without a clock-in anchor unprojected', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg()], // no clockInSystem at all
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    expect(out).toBe(doc);
  });

  it('leaves clock-skewed segments (now < clockIn) unprojected', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({ clockInSystem: NOW + HOUR })],
    };
    const [out] = projectOpenShiftsAt([doc], NOW);
    expect(out).toBe(doc);
  });

  it('feeds the CA OT engine: a projected 9h day splits into 8h regular + 1h OT', () => {
    const doc: DocumentData = {
      id: 'u1_2026-08-24',
      userId: 'u1',
      workDate: '2026-08-24',
      dayComplete: false,
      segments: [openSeg({ clockInSystem: NOW - 9 * HOUR, skipLunch: true })],
    };
    const [projected] = projectOpenShiftsAt([doc], NOW);
    expect(projected.totalWorkMinutes).toBe(540);

    // The projected entry flows through the same OT engine Payroll uses; the
    // cleared buckets force a fresh daily breakdown from projected totals.
    const totals = calculateBiweeklyOvertimeTotals([projected as OvertimeEntry], 1);
    expect(totals.grandTotals.totalMinutes).toBe(540);
    expect(totals.grandTotals.regularMinutes).toBe(480);
    expect(totals.grandTotals.otMinutes).toBe(60);
    expect(totals.grandTotals.doubleTimeMinutes).toBe(0);
  });
});
