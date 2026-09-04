import {
  getTimeZoneOffsetMs,
  localDateOf,
  localTimeHHMM,
  nextLocalMidnightMs,
  splitOpenSegmentAtLocalMidnight,
  splitSegmentAcrossMidnights,
  totalsByLocalDate,
} from './midnightSplit';

const MIN = 60_000;
const HOUR = 60 * MIN;

// A fixed anchor: 2026-07-28 12:00:00 UTC.
const T0 = Date.UTC(2026, 6, 28, 12, 0, 0);

describe('getTimeZoneOffsetMs', () => {
  it('UTC is zero', () => {
    expect(getTimeZoneOffsetMs('UTC', T0)).toBe(0);
  });
  it('America/New_York in July (EDT, UTC-4)', () => {
    expect(getTimeZoneOffsetMs('America/New_York', T0)).toBe(-4 * HOUR);
  });
  it('America/Los_Angeles in July (PDT, UTC-7)', () => {
    expect(getTimeZoneOffsetMs('America/Los_Angeles', T0)).toBe(-7 * HOUR);
  });
  it('Europe/Istanbul (UTC+3, no DST)', () => {
    expect(getTimeZoneOffsetMs('Europe/Istanbul', T0)).toBe(3 * HOUR);
  });
});

describe('localDateOf / localTimeHHMM', () => {
  it('UTC date and time', () => {
    expect(localDateOf(T0, 'UTC')).toBe('2026-07-28');
    expect(localTimeHHMM(T0, 'UTC')).toBe('12:00');
  });
  it('same instant, different zone may be different date', () => {
    // 2026-07-28 02:00 UTC = 2026-07-27 22:00 EDT (previous day in New York).
    const t = Date.UTC(2026, 6, 28, 2, 0, 0);
    expect(localDateOf(t, 'UTC')).toBe('2026-07-28');
    expect(localDateOf(t, 'America/New_York')).toBe('2026-07-27');
    expect(localTimeHHMM(t, 'America/New_York')).toBe('22:00');
  });
});

describe('nextLocalMidnightMs', () => {
  it('UTC: midnight after 2026-07-28 12:00 is 2026-07-29 00:00 UTC', () => {
    expect(nextLocalMidnightMs(Date.UTC(2026, 6, 28, 12, 0, 0), 'UTC')).toBe(Date.UTC(2026, 6, 29, 0, 0, 0));
  });
  it('America/New_York (EDT): local midnight = 04:00 UTC next day', () => {
    const m = nextLocalMidnightMs(Date.UTC(2026, 6, 28, 12, 0, 0), 'America/New_York');
    expect(m).toBe(Date.UTC(2026, 6, 29, 4, 0, 0));
    expect(localTimeHHMM(m, 'America/New_York')).toBe('00:00');
    expect(localDateOf(m, 'America/New_York')).toBe('2026-07-29');
  });
  it('Europe/Istanbul (UTC+3): local midnight = 21:00 UTC same UTC day', () => {
    // 2026-07-28 22:00 UTC = 2026-07-29 01:00 Istanbul. Next local midnight (Jul 30 00:00 IST)
    // = 2026-07-29 21:00 UTC.
    const m = nextLocalMidnightMs(Date.UTC(2026, 6, 28, 22, 0, 0), 'Europe/Istanbul');
    expect(m).toBe(Date.UTC(2026, 6, 29, 21, 0, 0));
    expect(localDateOf(m, 'Europe/Istanbul')).toBe('2026-07-30');
  });
  it('just before midnight returns the imminent midnight', () => {
    const m = nextLocalMidnightMs(Date.UTC(2026, 6, 28, 23, 59, 30), 'UTC');
    expect(m).toBe(Date.UTC(2026, 6, 29, 0, 0, 0));
  });
});

describe('splitOpenSegmentAtLocalMidnight', () => {
  it('returns null when the shift has NOT crossed midnight (single-day)', () => {
    // Clock in 08:00 UTC, now 17:00 UTC same day.
    const seg = { id: 'seg_1', clockInManual: '08:00', clockInSystem: T0, complete: false };
    expect(splitOpenSegmentAtLocalMidnight(seg, T0 + 9 * HOUR, 'UTC')).toBeNull();
  });

  it('splits a cross-midnight shift: Day1 closes 23:59, Day2 opens 00:00 (UTC)', () => {
    // Clock in 2026-07-28 22:00 UTC, now 2026-07-29 02:00 UTC.
    const start = Date.UTC(2026, 6, 28, 22, 0, 0);
    const now = Date.UTC(2026, 6, 29, 2, 0, 0);
    const seg = { id: 'seg_1', clockInManual: '22:00', clockInSystem: start, complete: false };
    const r = splitOpenSegmentAtLocalMidnight(seg, now, 'UTC');
    expect(r).not.toBeNull();
    const { day1, day2, midnightMs } = r!;
    expect(midnightMs).toBe(Date.UTC(2026, 6, 29, 0, 0, 0));
    // Day 1 closed at 23:59, complete, 2h of work (22:00->24:00).
    expect(day1.complete).toBe(true);
    expect(day1.clockOutManual).toBe('23:59');
    expect(day1.workMinutes).toBe(120);
    expect(day1.localDate).toBe('2026-07-28');
    expect(day1.autoClosed).toBe(true);
    // Day 2 open at 00:00 for the next day.
    expect(day2.complete).toBe(false);
    expect(day2.clockInManual).toBe('00:00');
    expect(day2.clockInSystem).toBe(midnightMs);
    expect(day2.localDate).toBe('2026-07-29');
  });

  it('uses the employee local zone for the boundary (America/New_York)', () => {
    // Clock in 2026-07-29 01:00 UTC = 2026-07-28 21:00 EDT. Now 2026-07-29 06:00 UTC = 02:00 EDT.
    const start = Date.UTC(2026, 6, 29, 1, 0, 0);
    const now = Date.UTC(2026, 6, 29, 6, 0, 0);
    const seg = { id: 'seg_1', clockInSystem: start, complete: false };
    const r = splitOpenSegmentAtLocalMidnight(seg, now, 'America/New_York');
    expect(r).not.toBeNull();
    const { day1, day2, midnightMs } = r!;
    // Local midnight = 04:00 UTC.
    expect(midnightMs).toBe(Date.UTC(2026, 6, 29, 4, 0, 0));
    expect(day1.localDate).toBe('2026-07-28');
    expect(day1.workMinutes).toBe(3 * 60); // 21:00->24:00 EDT
    expect(day2.localDate).toBe('2026-07-29');
    expect(day2.clockInManual).toBe('00:00');
  });

  it('LUNCH EDGE CASE: on lunch at midnight closes Day1 lunch + opens Day2 on-lunch', () => {
    const start = Date.UTC(2026, 6, 28, 20, 0, 0); // 20:00 UTC clock in
    const lunchOut = Date.UTC(2026, 6, 28, 23, 0, 0); // on lunch from 23:00
    const now = Date.UTC(2026, 6, 29, 1, 0, 0); // 01:00 next day
    const seg = {
      id: 'seg_1',
      clockInSystem: start,
      lunchOutSystem: lunchOut,
      // no lunchInSystem → currently on lunch
      complete: false,
    };
    const r = splitOpenSegmentAtLocalMidnight(seg, now, 'UTC');
    expect(r).not.toBeNull();
    const { day1, day2, midnightMs } = r!;
    // Day 1: shift closed AND lunch closed at 23:59:59.
    expect(day1.complete).toBe(true);
    expect(day1.lunchInSystem).toBe(midnightMs - 1000);
    expect(day1.lunchInManual).toBe('23:59');
    expect(day1.workMinutes).toBe(3 * 60); // 20:00->24:00 (4h) - 1h lunch(23:00->24:00) = 3h
    // Day 2: opens already ON lunch (lunchOut set, lunchIn unset).
    expect(day2.complete).toBe(false);
    expect(day2.lunchOutSystem).toBe(midnightMs);
    expect(day2.lunchInSystem).toBeUndefined();
    expect(day2.clockInSystem).toBe(midnightMs);
  });
});

describe('splitSegmentAcrossMidnights', () => {
  it('a 50-hour shift splits into 3 portions (2 complete + 1 open)', () => {
    const start = Date.UTC(2026, 6, 28, 8, 0, 0); // Jul 28 08:00 UTC
    const now = Date.UTC(2026, 6, 30, 10, 0, 0); // Jul 30 10:00 UTC (50h later)
    const seg = { id: 'seg_1', clockInSystem: start, complete: false };
    const parts = splitSegmentAcrossMidnights(seg, now, 'UTC');
    expect(parts).toHaveLength(3);
    expect(parts[0].complete).toBe(true);
    expect(parts[0].localDate).toBe('2026-07-28');
    expect(parts[1].complete).toBe(true);
    expect(parts[1].localDate).toBe('2026-07-29');
    expect(parts[2].complete).toBe(false);
    expect(parts[2].localDate).toBe('2026-07-30');
  });

  it('single-day shift returns one portion', () => {
    const seg = { id: 'seg_1', clockInSystem: T0, complete: false };
    const parts = splitSegmentAcrossMidnights(seg, T0 + 4 * HOUR, 'UTC');
    expect(parts).toHaveLength(1);
    expect(parts[0].complete).toBe(false);
  });
});

describe('totalsByLocalDate', () => {
  it('attributes each split portion to its own local date', () => {
    const start = Date.UTC(2026, 6, 28, 22, 0, 0);
    const now = Date.UTC(2026, 6, 29, 2, 0, 0);
    const seg = { id: 'seg_1', clockInSystem: start, complete: false };
    const parts = splitSegmentAcrossMidnights(seg, now, 'UTC');
    const totals = totalsByLocalDate(parts, now);
    // Day1 22:00->24:00 = 120; Day2 00:00->02:00 = 120.
    expect(totals['2026-07-28']).toBe(120);
    expect(totals['2026-07-29']).toBe(120);
  });
});
