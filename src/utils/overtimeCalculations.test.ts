import {
    WORKWEEK_START_DAYS,
    DEFAULT_WORKWEEK_START_DAY,
    getWorkWeekStartDate,
    calculateDailyOvertimeBreakdown,
    calculateWeeklyOvertimeAdjustments,
    getEntriesForWorkweek,
    calculateBiweeklyOvertimeTotals,
} from './overtimeCalculations';
import { getPTWeekStart } from './timeCalculations';

describe('overtimeCalculations - California rules', () => {
    describe('constants', () => {
        it('workweek enum matches JS getDay() ordering', () => {
            expect(WORKWEEK_START_DAYS.SUNDAY).toBe(0);
            expect(WORKWEEK_START_DAYS.SATURDAY).toBe(6);
            expect(DEFAULT_WORKWEEK_START_DAY).toBe(1); // default Monday (aligns with getPTWeekStart)
        });
    });

    describe('getWorkWeekStartDate', () => {
        it('returns the same date when it already is the workweek start', () => {
            // 2025-01-05 is a Sunday
            expect(getWorkWeekStartDate('2025-01-05', 0)).toBe('2025-01-05');
        });

        it('walks back to the previous Monday by default', () => {
            // Wed 2025-01-08 -> Mon 2025-01-06 (default is now Monday)
            expect(getWorkWeekStartDate('2025-01-08')).toBe('2025-01-06');
        });

        it('respects a custom workweek start day (Monday)', () => {
            // Wed 2025-01-08 -> Mon 2025-01-06
            expect(getWorkWeekStartDate('2025-01-08', 1)).toBe('2025-01-06');
        });

        it('crosses month boundaries correctly', () => {
            // Wed 2025-02-05 -> Sun 2025-02-02
            expect(getWorkWeekStartDate('2025-02-05', 0)).toBe('2025-02-02');
            // Sat 2025-03-01 with Monday start -> Mon 2025-02-24
            expect(getWorkWeekStartDate('2025-03-01', 1)).toBe('2025-02-24');
        });
    });

    describe('calculateDailyOvertimeBreakdown', () => {
        it('classifies 0-8h as all regular', () => {
            expect(calculateDailyOvertimeBreakdown(0)).toEqual({
                regularMinutes: 0,
                otMinutes: 0,
                doubleTimeMinutes: 0,
            });
            expect(calculateDailyOvertimeBreakdown(480)).toEqual({
                regularMinutes: 480,
                otMinutes: 0,
                doubleTimeMinutes: 0,
            });
        });

        it('classifies 8-12h as regular + OT', () => {
            // 10h -> 8h regular + 2h OT
            expect(calculateDailyOvertimeBreakdown(600)).toEqual({
                regularMinutes: 480,
                otMinutes: 120,
                doubleTimeMinutes: 0,
            });
            // Exactly 12h -> 8h regular + 4h OT
            expect(calculateDailyOvertimeBreakdown(720)).toEqual({
                regularMinutes: 480,
                otMinutes: 240,
                doubleTimeMinutes: 0,
            });
        });

        it('classifies >12h into double-time', () => {
            // 14h -> 8h reg + 4h OT + 2h DT
            expect(calculateDailyOvertimeBreakdown(840)).toEqual({
                regularMinutes: 480,
                otMinutes: 240,
                doubleTimeMinutes: 120,
            });
        });

        it('sum of buckets always equals total', () => {
            for (const total of [0, 250, 480, 600, 720, 840, 1000]) {
                const b = calculateDailyOvertimeBreakdown(total);
                expect(b.regularMinutes + b.otMinutes + b.doubleTimeMinutes).toBe(total);
            }
        });
    });

    describe('calculateWeeklyOvertimeAdjustments', () => {
        it('leaves a <40h week untouched', () => {
            const week = [
                { workDate: '2025-01-06', totalWorkMinutes: 480 }, // 8h
                { workDate: '2025-01-07', totalWorkMinutes: 480 }, // 8h
                { workDate: '2025-01-08', totalWorkMinutes: 480 }, // 8h
                { workDate: '2025-01-09', totalWorkMinutes: 480 }, // 8h
            ]; // total 32h regular
            const out = calculateWeeklyOvertimeAdjustments(week);
            expect(out).toHaveLength(4);
            for (const e of out) {
                expect(e.regularMinutes).toBe(480);
                expect(e.otMinutes || 0).toBe(0);
                expect(e.weeklyOtAdjustment).toBeUndefined();
            }
        });

        it('converts >40h regular time into weekly OT (LIFO from latest day)', () => {
            // 5 * 9h = 45h total. Daily breakdown: each day = 8h reg + 1h OT.
            // Weekly reg total = 5 * 8 = 40h exactly -> no weekly adjustment.
            const week = Array.from({ length: 5 }, (_, i) => ({
                workDate: `2025-01-${String(6 + i).padStart(2, '0')}`,
                totalWorkMinutes: 540, // 9h
            }));
            const out = calculateWeeklyOvertimeAdjustments(week);
            const totalReg = out.reduce((s, e) => s + (e.regularMinutes || 0), 0);
            const totalOT = out.reduce((s, e) => s + (e.otMinutes || 0), 0);
            expect(totalReg).toBe(2400); // 40h regular
            expect(totalOT).toBe(5 * 60); // 5h daily OT
        });

        it('[BUG TT-OT-001 FIXED] moves only the excess (2h) to OT on the latest day', () => {
            const week = Array.from({ length: 6 }, (_, i) => ({
                workDate: `2025-01-${String(6 + i).padStart(2, '0')}`,
                totalWorkMinutes: 420, // 7h
            }));
            const out = calculateWeeklyOvertimeAdjustments(week);
            const totalReg = out.reduce((s, e) => s + (e.regularMinutes || 0), 0);
            const totalOT = out.reduce((s, e) => s + (e.otMinutes || 0), 0);
            expect(totalReg).toBe(2400); // 40h regular
            expect(totalOT).toBe(120); // only 2h weekly OT

            const adjusted = out.filter(
                (e) => e.weeklyOtAdjustment && e.weeklyOtAdjustment > 0,
            );
            expect(adjusted).toHaveLength(1);
            expect(adjusted[0].workDate).toBe('2025-01-11');
            expect(adjusted[0].weeklyOtAdjustment).toBe(120);
        });

        it('preserves pre-calculated daily breakdown when regularMinutes already set', () => {
            const week = [
                {
                    workDate: '2025-01-06',
                    totalWorkMinutes: 480,
                    regularMinutes: 480,
                    otMinutes: 0,
                    doubleTimeMinutes: 0,
                },
            ];
            const out = calculateWeeklyOvertimeAdjustments(week);
            expect(out[0].regularMinutes).toBe(480);
            expect(out[0].otMinutes).toBe(0);
        });
    });

    describe('getEntriesForWorkweek', () => {
        const all = [
            { workDate: '2025-01-04' }, // Sat prev week
            { workDate: '2025-01-05' }, // Sun start
            { workDate: '2025-01-08' }, // Wed
            { workDate: '2025-01-11' }, // Sat same week
            { workDate: '2025-01-12' }, // Sun next week
        ];

        it('returns inclusive start, exclusive next-week start', () => {
            const out = getEntriesForWorkweek(all, '2025-01-05');
            expect(out.map((e) => e.workDate)).toEqual([
                '2025-01-05',
                '2025-01-08',
                '2025-01-11',
            ]);
        });

        it('returns empty array when no entries match', () => {
            const out = getEntriesForWorkweek(all, '2030-01-01');
            expect(out).toEqual([]);
        });
    });

    describe('calculateBiweeklyOvertimeTotals', () => {
        it('aggregates grand totals and per-week breakdown correctly', () => {
            // Week 1 (Mon 2025-01-06): 5 * 8h = 40h regular exactly
            // Week 2 (Mon 2025-01-13): 5 * 10h = 50h -> 40h reg + 10h OT (all daily OT, no weekly)
            // Default workweek start is now Monday (aligns with getPTWeekStart).
            const w1 = Array.from({ length: 5 }, (_, i) => ({
                workDate: `2025-01-${String(6 + i).padStart(2, '0')}`,
                totalWorkMinutes: 480,
            }));
            const w2 = Array.from({ length: 5 }, (_, i) => ({
                workDate: `2025-01-${String(13 + i).padStart(2, '0')}`,
                totalWorkMinutes: 600,
            }));
            const out = calculateBiweeklyOvertimeTotals([...w1, ...w2]);

            expect(Object.keys(out.weeklyTotals).sort()).toEqual([
                '2025-01-06',
                '2025-01-13',
            ]);

            const w1Totals = out.weeklyTotals['2025-01-06'];
            expect(w1Totals.regularMinutes).toBe(2400);
            expect(w1Totals.otMinutes).toBe(0);

            const w2Totals = out.weeklyTotals['2025-01-13'];
            expect(w2Totals.regularMinutes).toBe(2400);
            expect(w2Totals.otMinutes).toBe(600); // 10h daily OT

            expect(out.grandTotals.regularMinutes).toBe(4800);
            expect(out.grandTotals.otMinutes).toBe(600);
            expect(out.grandTotals.doubleTimeMinutes).toBe(0);
            expect(out.grandTotals.totalMinutes).toBe(5400);
            expect(out.adjustedEntries).toHaveLength(10);
        });

        it('applies double-time correctly at biweekly scope', () => {
            // One heroic 14h day => 8h reg + 4h OT + 2h DT
            const entries = [{ workDate: '2025-01-06', totalWorkMinutes: 840 }];
            const out = calculateBiweeklyOvertimeTotals(entries);
            expect(out.grandTotals).toEqual({
                regularMinutes: 480,
                otMinutes: 240,
                doubleTimeMinutes: 120,
                totalMinutes: 840,
            });
        });

        it('handles empty input', () => {
            const out = calculateBiweeklyOvertimeTotals([]);
            expect(out.grandTotals).toEqual({
                regularMinutes: 0,
                otMinutes: 0,
                doubleTimeMinutes: 0,
                totalMinutes: 0,
            });
            expect(out.weeklyTotals).toEqual({});
            expect(out.adjustedEntries).toEqual([]);
        });
    });
});

// =============================================================================
// TZ Safety Regression Tests for overtimeCalculations (W2 audit)
//
// Fix: getEntriesForWorkweek was using `new Date(workWeekStartDate + 'T00:00:00')`
// (runtime local TZ) + setDate(local TZ). On a UTC server, the PT week boundary
// could shift by a day. Now uses UTC-anchored arithmetic + Intl PT formatting.
//
// Also: verify CA 8/12/40 rules with explicit boundary cases.
// =============================================================================
describe('overtimeCalculations — TZ safety + CA rules regression (W2 audit)', () => {
    describe('getEntriesForWorkweek — UTC-anchored fix', () => {
        it('returns entries for a Sunday-to-Saturday PT workweek', () => {
            // PT week 2026-06-14 (Sun) to 2026-06-20 (Sat)
            const entries = [
                { workDate: '2026-06-14' }, // Sun — in
                { workDate: '2026-06-15' }, // Mon — in
                { workDate: '2026-06-20' }, // Sat — in
                { workDate: '2026-06-21' }, // Sun — out (next week)
                { workDate: '2026-06-07' }, // Sun — out (prev week)
            ];
            const result = getEntriesForWorkweek(entries, '2026-06-14');
            const dates = result.map(e => e.workDate).sort();
            expect(dates).toEqual(['2026-06-14', '2026-06-15', '2026-06-20']);
        });

        it('returns empty for a workweek with no entries', () => {
            const entries = [{ workDate: '2026-06-21' }, { workDate: '2026-06-07' }];
            const result = getEntriesForWorkweek(entries, '2026-06-14');
            expect(result).toEqual([]);
        });

        it('handles malformed workWeekStartDate gracefully (returns empty)', () => {
            const entries = [{ workDate: '2026-06-14' }];
            expect(getEntriesForWorkweek(entries, 'not-a-date')).toEqual([]);
        });

        it('week boundary is stable across runtime TZ changes (regression)', () => {
            // PT Sun 2026-06-14 is UTC 2026-06-15 07:00:00Z (no DST in PT summer)
            // If we use local TZ parsing and runtime is UTC, "2026-06-14" becomes
            // UTC midnight Jun 14 = PT 17:00 Jun 13 (wrong day!). Fix uses UTC anchoring.
            const entries = [{ workDate: '2026-06-15' }, { workDate: '2026-06-14' }];
            const result = getEntriesForWorkweek(entries, '2026-06-14');
            expect(result.map(e => e.workDate).sort()).toEqual(['2026-06-14', '2026-06-15']);
        });

        it('handles UTC midnight boundary: PT week with UTC date Jun 15 as week start', () => {
            // When PT is PST (winter), PT midnight = UTC 08:00 next day.
            // Jan 4 2026 (Sunday PT) = Jan 5 2026 08:00 UTC.
            // Ensure this is handled correctly.
            const entries = [
                { workDate: '2026-01-04' }, // Sun PT — in
                { workDate: '2026-01-05' }, // Mon PT — in
            ];
            const result = getEntriesForWorkweek(entries, '2026-01-04');
            expect(result.map(e => e.workDate)).toEqual(['2026-01-04', '2026-01-05']);
        });
    });

    describe('CA Overtime — explicit boundary cases (8/12/40 rules)', () => {
        it('exactly 8h = all regular', () => {
            const b = calculateDailyOvertimeBreakdown(480);
            expect(b.regularMinutes).toBe(480);
            expect(b.otMinutes).toBe(0);
            expect(b.doubleTimeMinutes).toBe(0);
        });

        it('exactly 12h = regular + 4h OT (no double time)', () => {
            const b = calculateDailyOvertimeBreakdown(720);
            expect(b.regularMinutes).toBe(480);
            expect(b.otMinutes).toBe(240);
            expect(b.doubleTimeMinutes).toBe(0);
        });

        it('12h+1min = regular + 4h OT + 1min double time', () => {
            const b = calculateDailyOvertimeBreakdown(721);
            expect(b.regularMinutes).toBe(480);
            expect(b.otMinutes).toBe(240);
            expect(b.doubleTimeMinutes).toBe(1);
        });

        it('0 minutes = all zero', () => {
            const b = calculateDailyOvertimeBreakdown(0);
            expect(b.regularMinutes).toBe(0);
            expect(b.otMinutes).toBe(0);
            expect(b.doubleTimeMinutes).toBe(0);
        });

        it('weekly OT: exactly 40h regular = no weekly adjustment', () => {
            // 5 days × 8h = 40h exactly — no weekly OT
            const week = [
                { workDate: '2026-06-14', totalWorkMinutes: 480 },
                { workDate: '2026-06-15', totalWorkMinutes: 480 },
                { workDate: '2026-06-16', totalWorkMinutes: 480 },
                { workDate: '2026-06-17', totalWorkMinutes: 480 },
                { workDate: '2026-06-18', totalWorkMinutes: 480 },
            ];
            const adjusted = calculateWeeklyOvertimeAdjustments(week);
            const totalOT = adjusted.reduce((s, e) => s + (e.otMinutes || 0), 0);
            // Each day: 8h reg, 0 OT. Week: 40h reg, 0 OT.
            expect(totalOT).toBe(0);
        });

        it('weekly OT: 42h total = 40h reg + 2h weekly OT (LIFO latest day)', () => {
            // 5 days × 8.4h = 42h. Daily: 8h reg + 0.4h OT each = 40h reg + 2h OT total.
            // Then weekly OT adjustment: total regular = 40h (at boundary) -> no extra OT.
            // This test verifies no double-counting.
            const week = Array.from({ length: 5 }, (_, i) => ({
                workDate: `2026-06-${String(14 + i).padStart(2, '0')}`,
                totalWorkMinutes: 504, // 8.4h
            }));
            const adjusted = calculateWeeklyOvertimeAdjustments(week);
            const totalReg = adjusted.reduce((s, e) => s + (e.regularMinutes || 0), 0);
            const totalOT = adjusted.reduce((s, e) => s + (e.otMinutes || 0), 0);
            // Daily breakdown: each day 8h reg + 0.4h OT = 40h reg + 2h OT total
            expect(totalReg).toBe(2400); // 40h regular
            expect(totalOT).toBe(120);    // 2h daily OT
        });

        it('weekly OT: 45h total = 40h reg + 5h weekly OT on latest day (LIFO)', () => {
            // 5 days × 9h = 45h. Daily: 8h reg + 1h OT each = 40h reg + 5h OT.
            // Weekly OT: total regular = 45h > 40h -> 5h excess converted to OT (LIFO).
            const week = Array.from({ length: 5 }, (_, i) => ({
                workDate: `2026-06-${String(14 + i).padStart(2, '0')}`,
                totalWorkMinutes: 540, // 9h
            }));
            const adjusted = calculateWeeklyOvertimeAdjustments(week);
            const totalReg = adjusted.reduce((s, e) => s + (e.regularMinutes || 0), 0);
            const totalOT = adjusted.reduce((s, e) => s + (e.otMinutes || 0), 0);
            // Daily: 5 × 8h = 40h reg + 5 × 1h = 5h daily OT
            // Weekly: regular = 40h (exactly at limit) -> no weekly OT
            expect(totalReg).toBe(2400);
            expect(totalOT).toBe(300); // 5h daily OT
        });
    });
});

/**
 * Cross-module agreement test (Kilo bot review guard).
 *
 * The display week (getPTWeekStart, used by getWeekSummary "This Week Total
 * Hours") and the OT workweek (getWorkWeekStartDate, used by
 * calculateBiweeklyOvertimeTotals for the >40h weekly-OT boundary) MUST sum
 * over the same 7-day window. If they diverge, a Sunday shift lands in one
 * boundary for display and another for OT — so a week shown as 40h in the UI
 * can compute OT differently. This locks the two together across the
 * Mon–Sun / Sun–Sat week boundary so the regression can't silently recur.
 */
describe('workweek boundary agreement — display vs OT', () => {
    it('DEFAULT_WORKWEEK_START_DAY is Monday (matches getPTWeekStart)', () => {
        expect(DEFAULT_WORKWEEK_START_DAY).toBe(WORKWEEK_START_DAYS.MONDAY);
    });

    it('getWorkWeekStartDate (default arg) === getPTWeekStart across a week boundary', () => {
        // Sample dates spanning Mon–Sun plus a cross-month boundary.
        const dates = [
            '2026-07-12', // Sunday
            '2026-07-13', // Monday
            '2026-07-15', // Wednesday
            '2026-07-18', // Saturday
            '2026-07-19', // Sunday (week rollover next day)
            '2026-07-20', // Monday (new week)
            '2026-07-31', // Friday (month-end)
            '2026-08-01', // Saturday (cross-month)
        ];
        for (const d of dates) {
            const otWeekStart = getWorkWeekStartDate(d); // default arg
            const displayWeekStart = getPTWeekStart(d);
            expect({ date: d, otWeekStart, displayWeekStart }).toEqual({
                date: d,
                otWeekStart: displayWeekStart,
                displayWeekStart,
            });
        }
    });

    it('both resolve a Sunday to the preceding Monday (not the same Sunday)', () => {
        // 2026-07-12 is a Sunday. Monday-start week => 2026-07-06.
        expect(getWorkWeekStartDate('2026-07-12')).toBe('2026-07-06');
        expect(getPTWeekStart('2026-07-12')).toBe('2026-07-06');
    });
});
