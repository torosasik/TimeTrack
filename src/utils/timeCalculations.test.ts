import {
    timeToMinutes,
    minutesToTime,
    calculateLunchMinutes,
    calculateTotalWorkMinutes,
    deriveSegmentWorkMinutes,
    formatMinutesToHoursMinutes,
    minutesToDecimalHours,
    formatHoursHMM,
    validateTimeEntry,
    checkLunchWarnings,
    getWarningMessage,
} from './timeCalculations';

describe('timeCalculations', () => {
    describe('timeToMinutes', () => {
        it('converts a basic HH:MM string to minutes', () => {
            expect(timeToMinutes('08:30')).toBe(8 * 60 + 30);
            expect(timeToMinutes('00:00')).toBe(0);
            expect(timeToMinutes('23:59')).toBe(23 * 60 + 59);
        });

        it.each([
            ['undefined', undefined, 0],
            ['null', null, 0],
            ['empty string', '', 0],
            ['whitespace-only', '   ', 0],
        ])('returns 0 for %s', (_label, input, expected) => {
            expect(timeToMinutes(input as any)).toBe(expected);
        });
    });

    describe('minutesToTime', () => {
        it('formats minutes back to zero-padded HH:MM', () => {
            expect(minutesToTime(0)).toBe('00:00');
            expect(minutesToTime(65)).toBe('01:05');
            expect(minutesToTime(8 * 60 + 30)).toBe('08:30');
            expect(minutesToTime(23 * 60 + 59)).toBe('23:59');
        });

        it('is the inverse of timeToMinutes', () => {
            for (const t of ['00:00', '07:15', '12:00', '18:45', '23:59']) {
                expect(minutesToTime(timeToMinutes(t))).toBe(t);
            }
        });
    });

    describe('calculateLunchMinutes', () => {
        it('returns the delta between lunchOut and lunchIn', () => {
            expect(calculateLunchMinutes('12:00', '12:30')).toBe(30);
            expect(calculateLunchMinutes('12:00', '13:00')).toBe(60);
        });

        it('returns 0 when either endpoint is missing', () => {
            expect(calculateLunchMinutes('', '13:00')).toBe(0);
            expect(calculateLunchMinutes('12:00', '')).toBe(0);
            expect(calculateLunchMinutes('', '')).toBe(0);
        });
    });

    describe('calculateTotalWorkMinutes', () => {
        it('subtracts lunch from the shift length', () => {
            // 09:00 -> 17:00 = 480 min, minus 30 lunch = 450
            expect(calculateTotalWorkMinutes('09:00', '17:00', 30)).toBe(450);
        });

        it('returns 0 when clock in/out missing', () => {
            expect(calculateTotalWorkMinutes('', '17:00', 30)).toBe(0);
            expect(calculateTotalWorkMinutes('09:00', '', 30)).toBe(0);
        });

        it('supports a zero-lunch workday', () => {
            expect(calculateTotalWorkMinutes('08:00', '12:00', 0)).toBe(240);
        });
    });

    describe('deriveSegmentWorkMinutes', () => {
        // Canonical helper shared by mapEntry (database.ts) and TodayEntry
        // submit flows. Pins the lunch-aware shift-minutes contract so a
        // future drift between the three call sites fails loudly here.
        it('subtracts lunch when both endpoints present and not skipped', () => {
            // 09:00 -> 17:00 = 480, lunch 12:00-12:30 = 30 → 450
            expect(deriveSegmentWorkMinutes('09:00', '17:00', false, '12:00', '12:30')).toBe(450);
        });

        it('skips lunch deduction when skipLunch is true', () => {
            expect(deriveSegmentWorkMinutes('09:00', '17:00', true, '12:00', '12:30')).toBe(480);
        });

        it('skips lunch deduction when either lunch endpoint is missing', () => {
            expect(deriveSegmentWorkMinutes('09:00', '17:00', false, '', '12:30')).toBe(480);
            expect(deriveSegmentWorkMinutes('09:00', '17:00', false, '12:00', undefined)).toBe(480);
            expect(deriveSegmentWorkMinutes('09:00', '17:00', false, undefined, undefined)).toBe(480);
        });

        it('clamps negative results to 0', () => {
            // clockOut before clockIn → negative → 0
            expect(deriveSegmentWorkMinutes('17:00', '09:00', false, undefined, undefined)).toBe(0);
            // lunch longer than shift → negative → 0
            expect(deriveSegmentWorkMinutes('09:00', '10:00', false, '09:00', '11:00')).toBe(0);
        });

        it('treats missing clock strings as 0 minutes', () => {
            expect(deriveSegmentWorkMinutes('', '', false, undefined, undefined)).toBe(0);
            expect(deriveSegmentWorkMinutes(undefined, undefined, false, undefined, undefined)).toBe(0);
        });

        it('matches the exact 37-minute single-shift scenario (Timecamp Issue 2)', () => {
            expect(deriveSegmentWorkMinutes('12:30', '13:07', false, undefined, undefined)).toBe(37);
        });

        it('matches the exact 2-minute split-shift addition scenario (Timecamp Issue 2)', () => {
            expect(deriveSegmentWorkMinutes('14:00', '14:02', false, undefined, undefined)).toBe(2);
        });
    });

    describe('formatMinutesToHoursMinutes', () => {
        it('formats combined hours and minutes', () => {
            expect(formatMinutesToHoursMinutes(0)).toBe('0h 0m');
            expect(formatMinutesToHoursMinutes(59)).toBe('0h 59m');
            expect(formatMinutesToHoursMinutes(60)).toBe('1h 0m');
            expect(formatMinutesToHoursMinutes(8 * 60 + 15)).toBe('8h 15m');
        });
    });

    describe('minutesToDecimalHours', () => {
        it('returns 2-decimal decimal hours', () => {
            expect(minutesToDecimalHours(0)).toBe('0.00');
            expect(minutesToDecimalHours(30)).toBe('0.50');
            expect(minutesToDecimalHours(450)).toBe('7.50');
        });
    });

    describe('formatHoursHMM', () => {
        it('formats decimal hours to H:MM', () => {
            expect(formatHoursHMM(2.5)).toBe('2:30');
            expect(formatHoursHMM(0)).toBe('0:00');
            expect(formatHoursHMM(12.75)).toBe('12:45');
        });

        it('rounds to nearest minute', () => {
            // 2.63h = 157.8 min -> rounds to 158 min = 2:38
            expect(formatHoursHMM(2.63)).toBe('2:38');
        });

        it('clamps negative values to 0:00', () => {
            expect(formatHoursHMM(-5)).toBe('0:00');
        });

        it.each([
            ['null', null],
            ['undefined', undefined],
            ['NaN', Number.NaN],
        ])('returns 0:00 for %s', (_label, input) => {
            expect(formatHoursHMM(input as any)).toBe('0:00');
        });

        // Regression (Timecamp.xlsx Issue 1, 2026-06-17): "Today so far"
        // showed raw minutes as if they were hours (e.g. 37 min → "37:00")
        // because callers passed integer minutes to a function that expects
        // DECIMAL HOURS. This test pins the units contract so a future caller
        // that breaks it fails loudly.
        it('EXPECTS decimal hours, NOT raw minutes (units contract)', () => {
            // 37 minutes of work MUST be passed as 37/60 ≈ 0.6167 decimal hours.
            expect(formatHoursHMM(37 / 60)).toBe('0:37');
            // Passing 37 (raw minutes) is the bug — it would render "37:00".
            expect(formatHoursHMM(37)).toBe('37:00');
            // 2.5h = "2:30" (the intended contract).
            expect(formatHoursHMM(2.5)).toBe('2:30');
        });
    });

    describe('validateTimeEntry', () => {
        const good = {
            clockInManual: '09:00',
            clockOutManual: '17:00',
            lunchOutManual: '12:00',
            lunchInManual: '12:30',
        };

        it('accepts a well-formed entry with lunch', () => {
            expect(validateTimeEntry(good)).toEqual([]);
        });

        it('accepts a well-formed entry without lunch', () => {
            expect(
                validateTimeEntry({
                    clockInManual: '09:00',
                    clockOutManual: '17:00',
                    lunchOutManual: '',
                    lunchInManual: '',
                }),
            ).toEqual([]);
        });

        it('flags clock-out before clock-in', () => {
            expect(
                validateTimeEntry({ ...good, clockOutManual: '08:00' }),
            ).toContain('Clock out must be after clock in');
        });

        it('requires both lunch fields together', () => {
            expect(
                validateTimeEntry({ ...good, lunchInManual: '' }),
            ).toContain('Both lunch times required or leave both empty');
            expect(
                validateTimeEntry({ ...good, lunchOutManual: '' }),
            ).toContain('Both lunch times required or leave both empty');
        });

        it('flags lunch_out before clock_in', () => {
            expect(
                validateTimeEntry({ ...good, lunchOutManual: '08:00' }),
            ).toContain('Lunch out must be after clock in');
        });

        it('flags lunch_in not after lunch_out', () => {
            expect(
                validateTimeEntry({
                    ...good,
                    lunchOutManual: '12:30',
                    lunchInManual: '12:30',
                }),
            ).toContain('Lunch in must be after lunch out');
        });

        it('flags clock_out not after lunch_in', () => {
            expect(
                validateTimeEntry({
                    ...good,
                    lunchInManual: '17:00',
                    clockOutManual: '17:00',
                }),
            ).toContain('Clock out must be after lunch in');
        });
    });

    describe('checkLunchWarnings', () => {
        it('flags lunch > 60 minutes', () => {
            expect(checkLunchWarnings(61)).toEqual(['lunch_too_long']);
            expect(checkLunchWarnings(120)).toEqual(['lunch_too_long']);
        });

        it('flags lunch between 1 and 29 minutes as too short', () => {
            expect(checkLunchWarnings(1)).toEqual(['lunch_too_short']);
            expect(checkLunchWarnings(29)).toEqual(['lunch_too_short']);
        });

        it('treats 0 minutes (no lunch) as no warning', () => {
            expect(checkLunchWarnings(0)).toEqual([]);
        });

        it('treats exactly 30 and 60 as the safe band', () => {
            expect(checkLunchWarnings(30)).toEqual([]);
            expect(checkLunchWarnings(60)).toEqual([]);
        });
    });

    describe('getWarningMessage', () => {
        it('returns a human-readable message for known codes', () => {
            expect(getWarningMessage('lunch_too_long')).toMatch(/60 minutes/);
            expect(getWarningMessage('lunch_too_short')).toMatch(/30 minutes/);
        });

        it('falls back to the raw code for unknown warnings', () => {
            expect(getWarningMessage('mystery_warning')).toBe('mystery_warning');
        });
    });
});

// =============================================================================
// PT Timezone Safety Regression Tests
// Ref: AGENTS.md §2 Guardrails — canonical timezone is America/Los_Angeles
// for all payroll math and storage. Never use browser Date directly.
// =============================================================================
import {
    getCurrentPTDate,
    getCurrentPTTimeHHMM,
    getPTDate,
    getPTWeekStart,
} from './timeCalculations';

describe('PT helpers — timezone safety (W2 audit)', () => {
    /**
     * getCurrentPTDate: must return the correct PT calendar date regardless of
     * the runtime's local timezone. Pin with known UTC instants.
     */
    describe('getCurrentPTDate', () => {
        it('returns PT 2026-06-15 when UTC is 2026-06-15T19:00:00Z (12:00 PT noon)', () => {
            const fakeNow = new Date('2026-06-15T19:00:00Z');
            const savedDate = global.Date;
            const MockDate = class extends (savedDate as any) {
                constructor(...args: unknown[]) {
                    if (args.length === 0) super(fakeNow);
                    else super(...(args as unknown[]));
                }
            };
            (global as any).Date = MockDate;
            try {
                const result = getCurrentPTDate();
                expect(result).toBe('2026-06-15');
            } finally {
                (global as any).Date = savedDate;
            }
        });

        it('returns PT 2026-06-14 when UTC is 2026-06-15T06:30:00Z (23:30 PT prev day)', () => {
            // 2026-06-15T06:30:00Z = 23:30 PT on June 14 (previous calendar day)
            const fakeNow = new Date('2026-06-15T06:30:00Z');
            const savedDate = global.Date;
            const MockDate = class extends (savedDate as any) {
                constructor(...args: unknown[]) {
                    if (args.length === 0) super(fakeNow);
                    else super(...(args as unknown[]));
                }
            };
            (global as any).Date = MockDate;
            try {
                const result = getCurrentPTDate();
                expect(result).toBe('2026-06-14');
            } finally {
                (global as any).Date = savedDate;
            }
        });

        it('PT date differs from UTC date near midnight PT boundary', () => {
            // 2026-06-15T06:59:59Z = 23:59 PT on June 14
            const fakeNow = new Date('2026-06-15T06:59:59Z');
            const savedDate = global.Date;
            const MockDate = class extends (savedDate as any) {
                constructor(...args: unknown[]) {
                    if (args.length === 0) super(fakeNow);
                    else super(...(args as unknown[]));
                }
            };
            (global as any).Date = MockDate;
            try {
                const result = getCurrentPTDate();
                expect(result).toBe('2026-06-14');
            } finally {
                (global as any).Date = savedDate;
            }
        });
    });

    /**
     * getCurrentPTTimeHHMM: must return wall-clock HH:MM in PT regardless of runtime TZ.
     */
    describe('getCurrentPTTimeHHMM', () => {
        it('returns 12:00 when UTC is 2026-06-15T19:00:00Z (noon PT)', () => {
            const fakeNow = new Date('2026-06-15T19:00:00Z');
            const savedDate = global.Date;
            const MockDate = class extends (savedDate as any) {
                constructor(...args: unknown[]) {
                    if (args.length === 0) super(fakeNow);
                    else super(...(args as unknown[]));
                }
            };
            (global as any).Date = MockDate;
            try {
                const result = getCurrentPTTimeHHMM();
                expect(result).toBe('12:00');
            } finally {
                (global as any).Date = savedDate;
            }
        });

        it('returns 23:30 when UTC is 2026-06-15T06:30:00Z (23:30 PT prev day)', () => {
            const fakeNow = new Date('2026-06-15T06:30:00Z');
            const savedDate = global.Date;
            const MockDate = class extends (savedDate as any) {
                constructor(...args: unknown[]) {
                    if (args.length === 0) super(fakeNow);
                    else super(...(args as unknown[]));
                }
            };
            (global as any).Date = MockDate;
            try {
                const result = getCurrentPTTimeHHMM();
                expect(result).toBe('23:30');
            } finally {
                (global as any).Date = savedDate;
            }
        });
    });

    /**
     * getPTDate: must convert a JS Date to the correct PT YYYY-MM-DD.
     */
    describe('getPTDate', () => {
        it('maps a UTC noon instant to PT Jun 15', () => {
            const utcNoon = new Date('2026-06-15T12:00:00Z');
            expect(getPTDate(utcNoon)).toBe('2026-06-15');
        });

        it('maps a UTC late-night instant to prior PT day (Jun 14)', () => {
            const utcLateNight = new Date('2026-06-15T06:30:00Z');
            expect(getPTDate(utcLateNight)).toBe('2026-06-14');
        });
    });

    /**
     * getPTWeekStart: PT week always starts on Monday (Mon–Sun workweek).
     */
    describe('getPTWeekStart', () => {
        it('returns the same PT Monday when given a PT Monday', () => {
            expect(getPTWeekStart('2026-06-15')).toBe('2026-06-15'); // Jun 15 2026 = Monday
        });

        it('returns the preceding PT Monday for a PT Tuesday', () => {
            expect(getPTWeekStart('2026-06-16')).toBe('2026-06-15'); // Jun 16 = Tuesday
        });

        it('returns the preceding PT Monday for a PT Sunday', () => {
            expect(getPTWeekStart('2026-06-14')).toBe('2026-06-08'); // Jun 14 = Sunday
        });

        it('returns the preceding PT Monday for a PT Saturday', () => {
            expect(getPTWeekStart('2026-06-20')).toBe('2026-06-15'); // Jun 20 = Saturday
        });

        it('crosses month boundary: Sunday at month start returns preceding Monday (prior month)', () => {
            expect(getPTWeekStart('2026-03-01')).toBe('2026-02-23'); // Mar 1 2026 = Sunday
        });

        it('handles default argument without throwing', () => {
            expect(() => getPTWeekStart()).not.toThrow();
        });
    });
});

// =============================================================================
// Employee-local timezone helpers (local-time-tracking refactor)
// =============================================================================
import {
    getEmployeeTimezone,
    getLocalDate,
    getLocalTimeHHMM,
    getTimezoneAbbreviation,
    formatInstantLocalHHMMAbbr,
    epochFromLocalWallTime,
} from './timeCalculations';
import { hhmmInZone } from './timeView';

describe('employee-local timezone helpers', () => {
    describe('getEmployeeTimezone', () => {
        it('prefers the profile timezone', () => {
            expect(getEmployeeTimezone('Europe/Istanbul')).toBe('Europe/Istanbul');
        });
        it('falls back to a valid IANA zone when profile tz is empty', () => {
            const tz = getEmployeeTimezone('');
            expect(typeof tz).toBe('string');
            expect(tz.length).toBeGreaterThan(0);
        });
    });

    describe('getLocalDate / getLocalTimeHHMM', () => {
        it('returns YYYY-MM-DD and HH:MM formats', () => {
            expect(getLocalDate('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(getLocalTimeHHMM('UTC')).toMatch(/^\d{2}:\d{2}$/);
        });
    });

    describe('getTimezoneAbbreviation — UTC (not GMT) offsets (Req 2a)', () => {
        const d = new Date(Date.UTC(2026, 6, 28, 12, 0, 0));
        it('normalizes GMT+3 to UTC+3 for Europe/Istanbul', () => {
            expect(getTimezoneAbbreviation('Europe/Istanbul', d)).toBe('UTC+3');
        });
        it('normalizes GMT+5:30 to UTC+5:30 for Asia/Kolkata', () => {
            expect(getTimezoneAbbreviation('Asia/Kolkata', d)).toBe('UTC+5:30');
        });
        it('keeps true abbreviations (PDT for America/Los_Angeles in July)', () => {
            expect(getTimezoneAbbreviation('America/Los_Angeles', d)).toBe('PDT');
        });
        it('keeps true abbreviations (EDT for America/New_York in July)', () => {
            expect(getTimezoneAbbreviation('America/New_York', d)).toBe('EDT');
        });
    });

    describe('formatInstantLocalHHMMAbbr', () => {
        it('includes the UTC offset abbreviation, not GMT', () => {
            const out = formatInstantLocalHHMMAbbr(Date.UTC(2026, 6, 28, 20, 32, 0), 'Europe/Istanbul');
            // 20:32 UTC = 23:32 Istanbul; banner shows local time + UTC+3.
            expect(out).toContain('11:32');
            expect(out).toContain('UTC+3');
            expect(out).not.toContain('GMT');
        });
    });

    describe('epochFromLocalWallTime — manual edit *System recompute', () => {
        it('converts a PDT wall time to the correct epoch (UTC-7 in July)', () => {
            // 2026-07-30 09:00 PDT = 16:00 UTC
            const ms = epochFromLocalWallTime('09:00', '2026-07-30', 'America/Los_Angeles');
            expect(ms).toBe(Date.UTC(2026, 6, 30, 16, 0, 0));
            // round-trip: format back to PDT HH:MM
            expect(hhmmInZone(ms!, 'America/Los_Angeles')).toBe('09:00');
        });

        it('converts an IST wall time (UTC+5:30)', () => {
            // 2026-07-30 09:00 IST = 03:30 UTC
            const ms = epochFromLocalWallTime('09:00', '2026-07-30', 'Asia/Kolkata');
            expect(ms).toBe(Date.UTC(2026, 6, 30, 3, 30, 0));
        });

        it('treats a punch earlier than clockIn as the next calendar day (cross-midnight)', () => {
            // clockIn 23:00, clockOut 02:00 -> clockOut is on 2026-07-31 02:00 PDT
            const ms = epochFromLocalWallTime('02:00', '2026-07-30', 'America/Los_Angeles', '23:00');
            expect(ms).toBe(Date.UTC(2026, 6, 31, 9, 0, 0)); // 07-31 02:00 PDT = 09:00 UTC
        });

        it('keeps a same-day punch on the anchor date (no false wrap)', () => {
            const ms = epochFromLocalWallTime('17:00', '2026-07-30', 'America/Los_Angeles', '09:00');
            expect(ms).toBe(Date.UTC(2026, 6, 31, 0, 0, 0)); // 07-30 17:00 PDT = 00:00 UTC 07-31
        });

        it('returns undefined when the manual string or date is absent', () => {
            expect(epochFromLocalWallTime(undefined, '2026-07-30', 'UTC')).toBeUndefined();
            expect(epochFromLocalWallTime('09:00', undefined, 'UTC')).toBeUndefined();
        });

        it('returns undefined for a malformed HH:MM', () => {
            expect(epochFromLocalWallTime('not-a-time', '2026-07-30', 'UTC')).toBeUndefined();
        });
    });
});
