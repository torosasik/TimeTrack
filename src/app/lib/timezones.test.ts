// Timezone resolver tests. These cover the 'auto' sentinel behavior
// (OS-TZ tracking + re-resolution), the live-clock formatting, and the
// profile-sync decision (timezoneToPersist) that persists the employee's
// selected/resolved zone to user.timezone.

import {
  AUTO_TIMEZONE,
  DEFAULT_DISPLAY_TIMEZONE,
  getOSTimezone,
  resolveDisplayTimezone,
  getDisplayClock,
  formatInstantHHMM,
  timezoneToPersist,
} from './timezones';

describe('timezones — auto / display resolvers', () => {
  it('DEFAULT_DISPLAY_TIMEZONE is the auto sentinel', () => {
    expect(DEFAULT_DISPLAY_TIMEZONE).toBe(AUTO_TIMEZONE);
    expect(DEFAULT_DISPLAY_TIMEZONE).toBe('auto');
  });

  it('getOSTimezone returns a non-empty IANA id', () => {
    const tz = getOSTimezone();
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
    // Should contain a slash for a real IANA id (e.g. Europe/Istanbul), or be
    // the documented fallback. Either way it must be a usable Intl timeZone.
    expect(() =>
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date())
    ).not.toThrow();
  });

  it("resolveDisplayTimezone('auto') === current OS timezone", () => {
    expect(resolveDisplayTimezone(AUTO_TIMEZONE)).toBe(getOSTimezone());
  });

  it("resolveDisplayTimezone returns a concrete IANA id unchanged (manual override)", () => {
    expect(resolveDisplayTimezone('Europe/Istanbul')).toBe('Europe/Istanbul');
    expect(resolveDisplayTimezone('America/Los_Angeles')).toBe('America/Los_Angeles');
  });

  it("getDisplayClock('auto') resolves the OS TZ and never leaks the 'auto' sentinel as zoneName", () => {
    const clock = getDisplayClock(AUTO_TIMEZONE);
    expect(clock.zoneName).not.toBe(AUTO_TIMEZONE);
    expect(clock.zoneName).toBe(getOSTimezone());
    // Date/time strings are well-formed (YYYY-MM-DD / HH:MM).
    expect(clock.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(clock.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('getDisplayClock with a manual IANA id formats in that zone', () => {
    const clock = getDisplayClock('America/Los_Angeles');
    expect(clock.zoneName).toBe('America/Los_Angeles');
    expect(clock.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(clock.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('formatInstantHHMM formats a fixed instant in the given zone (manual id)', () => {
    // 2026-07-18T18:40:00Z = 2026-07-18 11:40 PT, 2026-07-18 21:40 Istanbul.
    const epoch = Date.UTC(2026, 6, 18, 18, 40, 0);
    expect(formatInstantHHMM(epoch, 'America/Los_Angeles')).toBe('2026-07-18 11:40');
    expect(formatInstantHHMM(epoch, 'Europe/Istanbul')).toBe('2026-07-18 21:40');
  });

  it('formatInstantHHMM with auto resolves the OS TZ (matches getOSTimezone)', () => {
    const epoch = Date.now();
    expect(formatInstantHHMM(epoch, AUTO_TIMEZONE)).toBe(
      formatInstantHHMM(epoch, getOSTimezone()),
    );
  });

  it('formatInstantHHMM output matches YYYY-MM-DD HH:MM shape', () => {
    expect(formatInstantHHMM(Date.now(), 'America/Los_Angeles')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });
});

describe('timezoneToPersist — profile sync decision', () => {
  it('returns the concrete id for a manual selection that differs from stored', () => {
    expect(timezoneToPersist('Europe/Istanbul', 'America/Los_Angeles')).toBe('Europe/Istanbul');
  });

  it('returns null when the manual selection already matches the stored zone (no write)', () => {
    expect(timezoneToPersist('Europe/Istanbul', 'Europe/Istanbul')).toBeNull();
  });

  it("resolves 'auto' to the OS zone and returns it when it differs from stored", () => {
    const osZone = getOSTimezone();
    // Use a zone guaranteed to differ from the OS zone for the "differs" case.
    const otherZone = osZone === 'America/Los_Angeles' ? 'Europe/Istanbul' : 'America/Los_Angeles';
    expect(timezoneToPersist(AUTO_TIMEZONE, otherZone)).toBe(osZone);
  });

  it("returns null when 'auto' resolves to the same zone already stored (no write)", () => {
    const osZone = getOSTimezone();
    expect(timezoneToPersist(AUTO_TIMEZONE, osZone)).toBeNull();
  });

  it('returns null when stored zone is undefined only if the resolved zone is empty', () => {
    // A fresh profile (no stored tz) with a manual selection should persist.
    expect(timezoneToPersist('America/New_York', undefined)).toBe('America/New_York');
    // Auto with no stored tz persists the OS zone.
    expect(timezoneToPersist(AUTO_TIMEZONE, undefined)).toBe(getOSTimezone());
  });
});
