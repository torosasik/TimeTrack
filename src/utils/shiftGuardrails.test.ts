import {
  decideShiftAutoClose,
  decideLunchAutoEnd,
  detectGuardrailWarning,
  REMOTE_MAX_SHIFT_MS,
  LUNCH_AUTO_END_MS,
} from './shiftGuardrails';
import { epochFromLocalWallTime } from './timeCalculations';

// Asia/Bangkok (UTC+07:00) has no DST, so wall-clock ↔ epoch math is
// deterministic and avoids the DST-transition ambiguity in the test fixtures.
const TZ = 'Asia/Bangkok';
const DATE = '2026-08-14';

describe('shiftGuardrails — decideShiftAutoClose (On-site 10 PM)', () => {
  const clockIn = epochFromLocalWallTime('08:00', DATE, TZ)!;
  const closeAt = epochFromLocalWallTime('22:00', DATE, TZ)!;

  it('auto-closes at 22:00 local once past 10 PM', () => {
    const d = decideShiftAutoClose({
      nowMs: closeAt + 60_000,
      workModel: 'On-site',
      shift: { clockInSystem: clockIn, complete: false },
      timezone: TZ,
    });
    expect(d.reason).toBe('on_site_10pm');
    expect(d.actionAtMs).toBe(closeAt); // trigger stays the cutoff
    // actionManual is the RECORDED clock-out (Settings default 17:00), not
    // the trigger — the Automated Actions split introduced recordedAtMs.
    expect(d.recordedAtMs).toBe(epochFromLocalWallTime('17:00', DATE, TZ));
    expect(d.actionManual).toBe('17:00');
  });

  it('does not close before 10 PM', () => {
    const d = decideShiftAutoClose({
      nowMs: closeAt - 60_000,
      workModel: 'On-site',
      shift: { clockInSystem: clockIn, complete: false },
      timezone: TZ,
    });
    expect(d.reason).toBeNull();
    expect(d.actionAtMs).toBeNull();
  });

  it('clocked in after 10 PM closes at next-day 10 PM', () => {
    const lateIn = epochFromLocalWallTime('23:00', DATE, TZ)!;
    const nextClose = epochFromLocalWallTime('22:00', '2026-08-15', TZ)!;
    const d = decideShiftAutoClose({
      nowMs: nextClose + 60_000,
      workModel: 'On-site',
      shift: { clockInSystem: lateIn, complete: false },
      timezone: TZ,
    });
    expect(d.reason).toBe('on_site_10pm');
    expect(d.actionAtMs).toBe(nextClose);
  });

  it('never acts on a completed shift', () => {
    const d = decideShiftAutoClose({
      nowMs: closeAt + 60_000,
      workModel: 'On-site',
      shift: { clockInSystem: clockIn, complete: true },
      timezone: TZ,
    });
    expect(d.reason).toBeNull();
  });

  it('never acts when clock-in has no system timestamp', () => {
    const d = decideShiftAutoClose({
      nowMs: closeAt + 60_000,
      workModel: 'On-site',
      shift: { complete: false },
      timezone: TZ,
    });
    expect(d.reason).toBeNull();
  });
});

describe('shiftGuardrails — decideShiftAutoClose (Remote 12h)', () => {
  const clockIn = Date.UTC(2026, 7, 14, 1, 0, 0);

  it('auto-closes at 12h elapsed', () => {
    const d = decideShiftAutoClose({
      nowMs: clockIn + REMOTE_MAX_SHIFT_MS + 1,
      workModel: 'Remote',
      shift: { clockInSystem: clockIn, complete: false },
      timezone: TZ,
    });
    expect(d.reason).toBe('remote_12h');
    expect(d.actionAtMs).toBe(clockIn + REMOTE_MAX_SHIFT_MS);
  });

  it('does not close before 12h', () => {
    const d = decideShiftAutoClose({
      nowMs: clockIn + REMOTE_MAX_SHIFT_MS - 1,
      workModel: 'Remote',
      shift: { clockInSystem: clockIn, complete: false },
      timezone: TZ,
    });
    expect(d.reason).toBeNull();
  });

  it('treats any non-Remote model as On-site', () => {
    const d = decideShiftAutoClose({
      nowMs: clockIn + REMOTE_MAX_SHIFT_MS + 1,
      workModel: 'On-site',
      shift: { clockInSystem: clockIn, complete: false },
      timezone: TZ,
    });
    expect(d.reason).not.toBe('remote_12h');
  });
});

describe('shiftGuardrails — decideLunchAutoEnd (1h lunch)', () => {
  const lunchOut = Date.UTC(2026, 7, 14, 12, 0, 0);
  const clockIn = Date.UTC(2026, 7, 14, 8, 0, 0);

  it('ends lunch at 60m', () => {
    const d = decideLunchAutoEnd({
      nowMs: lunchOut + LUNCH_AUTO_END_MS + 1,
      shift: { clockInSystem: clockIn, lunchOutSystem: lunchOut, complete: false },
    });
    expect(d.reason).toBe('lunch_1h');
    expect(d.actionAtMs).toBe(lunchOut + LUNCH_AUTO_END_MS);
  });

  it('does not end before 60m', () => {
    const d = decideLunchAutoEnd({
      nowMs: lunchOut + LUNCH_AUTO_END_MS - 1,
      shift: { clockInSystem: clockIn, lunchOutSystem: lunchOut, complete: false },
    });
    expect(d.reason).toBeNull();
  });

  it('skips when lunch already ended or was skipped', () => {
    expect(
      decideLunchAutoEnd({
        nowMs: lunchOut + LUNCH_AUTO_END_MS + 1,
        shift: { clockInSystem: clockIn, lunchOutSystem: lunchOut, lunchInSystem: lunchOut + 30 * 60_000, complete: false },
      }).reason,
    ).toBeNull();
    expect(
      decideLunchAutoEnd({
        nowMs: lunchOut + LUNCH_AUTO_END_MS + 1,
        shift: { clockInSystem: clockIn, lunchOutSystem: lunchOut, skipLunch: true, complete: false },
      }).reason,
    ).toBeNull();
  });

  it('skips when never on lunch', () => {
    expect(
      decideLunchAutoEnd({ nowMs: lunchOut + LUNCH_AUTO_END_MS + 1, shift: { clockInSystem: clockIn, complete: false } }).reason,
    ).toBeNull();
  });
});

describe('shiftGuardrails — detectGuardrailWarning', () => {
  it('flags auto-closed entries (entry level)', () => {
    expect(detectGuardrailWarning([{ autoClosed: true }]).hasWarning).toBe(true);
  });

  it('flags auto-ended-lunch segments', () => {
    expect(detectGuardrailWarning([{ segments: [{ autoEndedLunch: true }] }]).hasWarning).toBe(true);
  });

  it('flags current-segment markers', () => {
    expect(detectGuardrailWarning([{ currentSegment: { autoClosed: true } }]).hasWarning).toBe(true);
  });

  it('ignores voided / archived / corrected entries', () => {
    expect(detectGuardrailWarning([{ autoClosed: true, status: 'voided' }]).hasWarning).toBe(false);
    expect(detectGuardrailWarning([{ autoClosed: true, status: 'archived' }]).hasWarning).toBe(false);
    expect(detectGuardrailWarning([{ autoClosed: true, status: 'corrected' }]).hasWarning).toBe(false);
  });

  it('no warning when nothing is flagged', () => {
    expect(detectGuardrailWarning([{ status: 'active' }]).hasWarning).toBe(false);
    expect(detectGuardrailWarning([]).hasWarning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Automated Actions (dynamic limits from systemSettings/global)
// ---------------------------------------------------------------------------

import { resolveGuardrailLimits, DEFAULT_GUARDRAIL_LIMITS } from './guardrailLimits';
import { guardrailWarningText, GUARDRAIL_WARNING_TEXT } from './shiftGuardrails';

describe('resolveGuardrailLimits', () => {
  it('returns defaults for null/missing settings', () => {
    expect(resolveGuardrailLimits(null)).toEqual(DEFAULT_GUARDRAIL_LIMITS);
    expect(resolveGuardrailLimits(undefined)).toEqual(DEFAULT_GUARDRAIL_LIMITS);
    expect(resolveGuardrailLimits({})).toEqual(DEFAULT_GUARDRAIL_LIMITS);
  });

  it('passes through valid custom values', () => {
    const L = resolveGuardrailLimits({
      onsiteLatestAllowedTime: '21:00',
      onsiteRecordedTime: '16:30',
      onsiteLunchMaxMinutes: 90,
      onsiteLunchRecordedMinutes: 45,
      remoteMaxWorkHours: 10,
    });
    expect(L.onsiteLatestAllowedTime).toBe('21:00');
    expect(L.onsiteRecordedTime).toBe('16:30');
    expect(L.onsiteLunchMaxMinutes).toBe(90);
    expect(L.onsiteLunchRecordedMinutes).toBe(45);
    expect(L.remoteMaxWorkHours).toBe(10);
  });

  it('falls back per-field on malformed values', () => {
    const L = resolveGuardrailLimits({
      onsiteLatestAllowedTime: '25:99',
      onsiteLunchMaxMinutes: -5,
      remoteMaxWorkHours: 0,
    });
    expect(L.onsiteLatestAllowedTime).toBe('22:00');
    expect(L.onsiteLunchMaxMinutes).toBe(120);
    expect(L.remoteMaxWorkHours).toBe(12);
  });
});

describe('shiftGuardrails — dynamic limits', () => {
  const clockIn = epochFromLocalWallTime('08:00', DATE, TZ)!;

  it('honors a custom on-site cutoff (21:00) and recorded time (16:30)', () => {
    const L = resolveGuardrailLimits({ onsiteLatestAllowedTime: '21:00', onsiteRecordedTime: '16:30' });
    const trigger = epochFromLocalWallTime('21:00', DATE, TZ)!;
    const recorded = epochFromLocalWallTime('16:30', DATE, TZ)!;
    const d = decideShiftAutoClose({
      nowMs: trigger + 60_000,
      workModel: 'On-site',
      shift: { clockInSystem: clockIn, complete: false },
      timezone: TZ,
      limits: L,
    });
    expect(d.reason).toBe('on_site_10pm');
    expect(d.actionAtMs).toBe(trigger);
    expect(d.recordedAtMs).toBe(recorded);
    expect(d.actionManual).toBe('16:30');
    // And it must NOT fire at the old default cutoff semantics:
    const before = decideShiftAutoClose({
      nowMs: trigger - 60_000,
      workModel: 'On-site',
      shift: { clockInSystem: clockIn, complete: false },
      timezone: TZ,
      limits: L,
    });
    expect(before.reason).toBeNull();
  });

  it('night-shift guard: recorded time before clock-in falls back to the trigger', () => {
    const lateIn = epochFromLocalWallTime('23:00', DATE, TZ)!;
    const d = decideShiftAutoClose({
      nowMs: epochFromLocalWallTime('23:30', '2026-08-15', TZ)!,
      workModel: 'On-site',
      shift: { clockInSystem: lateIn, complete: false },
      timezone: TZ,
    });
    expect(d.reason).toBe('on_site_10pm');
    // 17:00 on the clock-in date precedes a 23:00 clock-in → trigger used.
    expect(d.recordedAtMs).toBe(d.actionAtMs);
  });

  it('honors a custom remote max (10h)', () => {
    const L = resolveGuardrailLimits({ remoteMaxWorkHours: 10 });
    const trigger = clockIn + 10 * 60 * 60 * 1000;
    const d = decideShiftAutoClose({
      nowMs: trigger + 60_000,
      workModel: 'Remote',
      shift: { clockInSystem: clockIn, complete: false },
      timezone: TZ,
      limits: L,
    });
    expect(d.reason).toBe('remote_12h');
    expect(d.actionAtMs).toBe(trigger);
    expect(d.recordedAtMs).toBe(trigger);
  });

  it('lunch: fires at max minutes, records recorded minutes', () => {
    const L = resolveGuardrailLimits({ onsiteLunchMaxMinutes: 90, onsiteLunchRecordedMinutes: 45 });
    const lunchOut = clockIn + 4 * 60 * 60 * 1000;
    const d = decideLunchAutoEnd({
      nowMs: lunchOut + 91 * 60 * 1000,
      shift: { lunchOutSystem: lunchOut, complete: false },
      limits: L,
    });
    expect(d.reason).toBe('lunch_1h');
    expect(d.actionAtMs).toBe(lunchOut + 90 * 60 * 1000);
    expect(d.recordedAtMs).toBe(lunchOut + 45 * 60 * 1000);
    // Not yet due at 60min under a 90min max:
    const early = decideLunchAutoEnd({
      nowMs: lunchOut + 61 * 60 * 1000,
      shift: { lunchOutSystem: lunchOut, complete: false },
      limits: L,
    });
    expect(early.reason).toBeNull();
  });
});

describe('guardrailWarningText', () => {
  it('quotes the active limits when provided', () => {
    const text = guardrailWarningText(resolveGuardrailLimits({ onsiteLatestAllowedTime: '21:00', onsiteRecordedTime: '16:30' }));
    expect(text).toContain('21:00');
    expect(text).toContain('16:30');
  });

  it('falls back to the generic text without limits', () => {
    expect(guardrailWarningText(null)).toBe(GUARDRAIL_WARNING_TEXT);
  });
});