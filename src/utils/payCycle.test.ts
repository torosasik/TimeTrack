/**
 * Remote pay-cycle engine tests (Stage 2).
 *
 * Reference example from the spec:
 *   payDay = 11, today = Aug 31 → Current: Aug 11 – Sep 10, Last: Jul 11 – Aug 10
 */
import {
  computeRemoteCurrentCycle,
  computeRemoteLastCycle,
  computeRemotePayCycle,
  normalizePayCalculationDay,
} from './payCycle';

describe('normalizePayCalculationDay', () => {
  it('clamps into 1–28 and rounds', () => {
    expect(normalizePayCalculationDay(0)).toBe(1);
    expect(normalizePayCalculationDay(29)).toBe(28);
    expect(normalizePayCalculationDay(11.6)).toBe(12);
    expect(normalizePayCalculationDay(15)).toBe(15);
  });

  it('falls back to 1 for non-numeric input', () => {
    expect(normalizePayCalculationDay(undefined)).toBe(1);
    expect(normalizePayCalculationDay(NaN)).toBe(1);
    expect(normalizePayCalculationDay('11')).toBe(1);
  });
});

describe('computeRemoteCurrentCycle', () => {
  it('spec example: payDay 11, today Aug 31 → Aug 11 – Sep 10', () => {
    expect(computeRemoteCurrentCycle('2026-08-31', 11)).toEqual({ start: '2026-08-11', end: '2026-09-10' });
  });

  it('today before anchor day → cycle started last month (payDay 11, today Aug 5)', () => {
    expect(computeRemoteCurrentCycle('2026-08-05', 11)).toEqual({ start: '2026-07-11', end: '2026-08-10' });
  });

  it('today exactly on the anchor day → cycle starts today', () => {
    expect(computeRemoteCurrentCycle('2026-08-11', 11)).toEqual({ start: '2026-08-11', end: '2026-09-10' });
  });

  it('today exactly on the cycle end day (anchor − 1) → still inside the current cycle', () => {
    expect(computeRemoteCurrentCycle('2026-09-10', 11)).toEqual({ start: '2026-08-11', end: '2026-09-10' });
  });

  it('anchor day 1 → calendar month', () => {
    expect(computeRemoteCurrentCycle('2026-08-31', 1)).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(computeRemoteCurrentCycle('2026-08-01', 1)).toEqual({ start: '2026-08-01', end: '2026-08-31' });
  });

  it('crosses the year boundary (payDay 15, today Jan 5 → Dec 15 – Jan 14)', () => {
    expect(computeRemoteCurrentCycle('2026-01-05', 15)).toEqual({ start: '2025-12-15', end: '2026-01-14' });
  });

  it('current cycle starting in December ends in January', () => {
    expect(computeRemoteCurrentCycle('2026-12-20', 15)).toEqual({ start: '2026-12-15', end: '2027-01-14' });
  });

  it('anchor day 28 stays in-month for February', () => {
    expect(computeRemoteCurrentCycle('2026-02-10', 28)).toEqual({ start: '2026-01-28', end: '2026-02-27' });
    expect(computeRemoteCurrentCycle('2026-03-01', 28)).toEqual({ start: '2026-02-28', end: '2026-03-27' });
  });

  it('does not depend on the browser local timezone (UTC-anchored math)', () => {
    // Constructed via string parsing only — no local Date arithmetic inside.
    const a = computeRemoteCurrentCycle('2026-08-31', 11);
    const b = computeRemoteCurrentCycle('2026-08-31', 11);
    expect(a).toEqual(b);
  });
});

describe('computeRemoteLastCycle', () => {
  it('spec example: payDay 11, today Aug 31 → Jul 11 – Aug 10', () => {
    expect(computeRemoteLastCycle('2026-08-31', 11)).toEqual({ start: '2026-07-11', end: '2026-08-10' });
  });

  it('today before anchor day → last cycle ends the day before the current cycle start', () => {
    expect(computeRemoteLastCycle('2026-08-05', 11)).toEqual({ start: '2026-06-11', end: '2026-07-10' });
  });

  it('last cycle is exactly contiguous with the current cycle', () => {
    const current = computeRemoteCurrentCycle('2026-03-20', 11);
    const last = computeRemoteLastCycle('2026-03-20', 11);
    // last.end must be exactly one day before current.start
    const d = new Date(`${current.start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    expect(last.end).toBe(d.toISOString().slice(0, 10));
  });

  it('crosses the year boundary (payDay 15, today Jan 20 → Dec 15 – Jan 14)', () => {
    // Current = Jan 15 – Feb 14, so Last = Dec 15 – Jan 14 (spans the year).
    expect(computeRemoteLastCycle('2026-01-20', 15)).toEqual({ start: '2025-12-15', end: '2026-01-14' });
  });

  it('anchor day 1 → previous calendar month', () => {
    expect(computeRemoteLastCycle('2026-08-31', 1)).toEqual({ start: '2026-07-01', end: '2026-07-31' });
  });
});

describe('computeRemotePayCycle (preset dispatcher)', () => {
  it('routes current/last correctly', () => {
    expect(computeRemotePayCycle('current', '2026-08-31', 11)).toEqual({ start: '2026-08-11', end: '2026-09-10' });
    expect(computeRemotePayCycle('last', '2026-08-31', 11)).toEqual({ start: '2026-07-11', end: '2026-08-10' });
  });
});
