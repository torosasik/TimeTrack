/**
 * California Overtime Calculation Engine
 * 
 * Rules (defaults — can be overridden per-user via workModel/workModelOverride):
 * - Daily: 0-8h = Regular, 8-12h = OT (1.5×), >12h = Double Time (2×)
 * - Weekly: >40h regular = OT (don't double-count daily OT)
 * - Biweekly payroll: Sum across two workweeks
 * 
 * Rule resolution hierarchy (resolveOvertimeRules):
 *   1. workModelOverride?.hasCustomRules === true  → use override values
 *   2. workModel present                            → use work model values
 *   3. fallback                                      → CA defaults (8/12/1.5/2.0/40)
 * 
 * When resolved `noOvertime` is true, all OT/DT buckets are zeroed and every
 * worked minute is classified as regular (capped only by the weekly regular
 * max, which itself becomes the resolved weeklyOvertimeLimit).
 */

import { TimeEntry } from '../app/lib/database';
import type { WorkModelOverride } from '../app/lib/auth';
import type { WorkModel as WorkModelDef } from '../services/workModelsService';

// Workweek configuration
export const WORKWEEK_START_DAYS = {
    SUNDAY: 0,
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6
} as const;

// Default workweek starts on Monday.
// ALIGNMENT NOTE: this MUST agree with the display week (getPTWeekStart in
// timeCalculations.ts), which is also Monday-start. Changing one without the
// other re-introduces the divergence flagged by the Kilo bot review — where
// "This Week Total Hours" (display) and weekly-OT (>40h) summed over
// different 7-day windows (Mon–Sun vs Sun–Sat), a payroll-correctness
// hazard per AGENTS.md §2. There is a cross-module agreement test in
// overtimeCalculations.test.ts that locks the two together.
export const DEFAULT_WORKWEEK_START_DAY = WORKWEEK_START_DAYS.MONDAY;

// Default California rule values (in hours for clarity).
export const DEFAULT_DAILY_REGULAR_HOURS = 8;
export const DEFAULT_DAILY_OT_HOURS = 12;
export const DEFAULT_WEEKLY_OT_HOURS = 40;
export const DEFAULT_OT_MULTIPLIER = 1.5;
export const DEFAULT_DT_MULTIPLIER = 2.0;

// Resolved overtime rules, in MINUTES for the thresholds and unitless for the
// multipliers. Produced by resolveOvertimeRules() from workModel / override.
export interface OvertimeRules {
    noOvertime: boolean;
    dailyRegularMax: number;    // minutes (default 480)
    dailyOtMax: number;         // minutes (default 720)
    weeklyRegularMax: number;   // minutes (default 2400)
    otMultiplier: number;       // default 1.5
    dtMultiplier: number;       // default 2.0
}

const DEFAULT_RULES: OvertimeRules = {
    noOvertime: false,
    dailyRegularMax: DEFAULT_DAILY_REGULAR_HOURS * 60,
    dailyOtMax: DEFAULT_DAILY_OT_HOURS * 60,
    weeklyRegularMax: DEFAULT_WEEKLY_OT_HOURS * 60,
    otMultiplier: DEFAULT_OT_MULTIPLIER,
    dtMultiplier: DEFAULT_DT_MULTIPLIER,
};

/**
 * Resolve the active overtime rules for a user.
 * Priority: workModelOverride (if hasCustomRules) > workModel > CA defaults.
 * All thresholds are normalized to minutes and clamped to safe minimums so a
 * malformed stored value can never produce negative OT buckets.
 */
export function resolveOvertimeRules(
    workModel?: WorkModelDef | null,
    workModelOverride?: WorkModelOverride | null,
): OvertimeRules {
    const base: OvertimeRules = { ...DEFAULT_RULES };

    if (workModel) {
        base.dailyRegularMax = Math.max(0, Number(workModel.overtimeLimit ?? DEFAULT_DAILY_REGULAR_HOURS)) * 60;
        base.dailyOtMax = Math.max(0, Number(workModel.doubleTimeLimit ?? DEFAULT_DAILY_OT_HOURS)) * 60;
        base.weeklyRegularMax = Math.max(0, Number(workModel.weeklyOvertimeLimit ?? DEFAULT_WEEKLY_OT_HOURS)) * 60;
        base.otMultiplier = Number(workModel.overtimeMultiplier ?? DEFAULT_OT_MULTIPLIER) || DEFAULT_OT_MULTIPLIER;
        base.dtMultiplier = Number(workModel.doubleTimeMultiplier ?? DEFAULT_DT_MULTIPLIER) || DEFAULT_DT_MULTIPLIER;
        base.noOvertime = workModel.noOvertime === true;
    }

    if (workModelOverride && workModelOverride.hasCustomRules === true) {
        // Override wins per-field; an undefined override field falls back to
        // the workModel-or-default value already in `base`.
        if (typeof workModelOverride.overtimeLimit === 'number') {
            base.dailyRegularMax = Math.max(0, workModelOverride.overtimeLimit) * 60;
        }
        if (typeof workModelOverride.doubleTimeLimit === 'number') {
            base.dailyOtMax = Math.max(0, workModelOverride.doubleTimeLimit) * 60;
        }
        if (typeof workModelOverride.weeklyOvertimeLimit === 'number') {
            base.weeklyRegularMax = Math.max(0, workModelOverride.weeklyOvertimeLimit) * 60;
        }
        if (typeof workModelOverride.overtimeMultiplier === 'number') {
            base.otMultiplier = workModelOverride.overtimeMultiplier || DEFAULT_OT_MULTIPLIER;
        }
        if (typeof workModelOverride.doubleTimeMultiplier === 'number') {
            base.dtMultiplier = workModelOverride.doubleTimeMultiplier || DEFAULT_DT_MULTIPLIER;
        }
        if (typeof workModelOverride.noOvertime === 'boolean') {
            base.noOvertime = workModelOverride.noOvertime;
        }
    }

    // Guarantee dailyOtMax >= dailyRegularMax so the OT band is never negative.
    if (base.dailyOtMax < base.dailyRegularMax) {
        base.dailyOtMax = base.dailyRegularMax;
    }

    return base;
}

/**
 * Calculate workweek start date for a given date
 * @param dateStr - Date in YYYY-MM-DD format (interpreted as a calendar date, not a TZ-relative instant)
 * @param workweekStartDay - Day of week workweek starts (0=Sunday)
 * @returns Workweek start date in YYYY-MM-DD format
 *
 * Bug fix: previously used `new Date(dateStr + 'T00:00:00').getDay()`, which is
 * parsed in the *runtime's* local timezone. On a UTC server, an LA employee's
 * "2024-03-15" could be read as 2024-03-15 00:00 UTC = 2024-03-14 17:00 PT,
 * shifting their workweek boundary by a day and corrupting weekly OT. Now
 * uses UTC-anchored parsing so the calendar day is the calendar day regardless
 * of runtime timezone.
 */
export function getWorkWeekStartDate(dateStr: string, workweekStartDay: number = DEFAULT_WORKWEEK_START_DAY): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return dateStr; // graceful fallback
    const date = new Date(Date.UTC(y, m - 1, d));
    const dayOfWeek = date.getUTCDay();

    // Calculate how many days back to the workweek start
    let daysBack = (dayOfWeek - workweekStartDay + 7) % 7;

    date.setUTCDate(date.getUTCDate() - daysBack);

    const yy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

interface DailyOvertimeBreakdown {
    regularMinutes: number;
    otMinutes: number;
    doubleTimeMinutes: number;
}

/**
 * Calculate daily overtime breakdown
 * California Rule: 0-8h regular, 8-12h OT, >12h double time (defaults overridable)
 * 
 * @param totalWorkMinutes - Total work minutes for the day
 * @param workModel - Optional work model (overrides CA defaults)
 * @param workModelOverride - Optional per-user override (wins over workModel)
 * @returns { regularMinutes, otMinutes, doubleTimeMinutes }
 */
export function calculateDailyOvertimeBreakdown(
    totalWorkMinutes: number,
    workModel?: WorkModelDef | null,
    workModelOverride?: WorkModelOverride | null,
): DailyOvertimeBreakdown {
    const rules = resolveOvertimeRules(workModel, workModelOverride);
    let regularMinutes = 0;
    let otMinutes = 0;
    let doubleTimeMinutes = 0;

    if (rules.noOvertime) {
        // No OT/DT for this rule set: everything is regular (still bounded by
        // the weekly regular cap applied later in calculateWeeklyOvertimeAdjustments).
        regularMinutes = Math.max(0, totalWorkMinutes);
        return { regularMinutes, otMinutes: 0, doubleTimeMinutes: 0 };
    }

    if (totalWorkMinutes <= rules.dailyRegularMax) {
        // All regular time (0-8 hours by default)
        regularMinutes = totalWorkMinutes;
    } else if (totalWorkMinutes <= rules.dailyOtMax) {
        // Regular + OT (8-12 hours by default)
        regularMinutes = rules.dailyRegularMax;
        otMinutes = totalWorkMinutes - rules.dailyRegularMax;
    } else {
        // Regular + OT + Double Time (>12 hours by default)
        regularMinutes = rules.dailyRegularMax;
        otMinutes = rules.dailyOtMax - rules.dailyRegularMax; // 240 minutes (4 hours) by default
        doubleTimeMinutes = totalWorkMinutes - rules.dailyOtMax;
    }

    return {
        regularMinutes,
        otMinutes,
        doubleTimeMinutes
    };
}

// Partial TimeEntry with enough info for overtime calcs, plus the optional weekly adjustment field.
// The *Time fields are direct HH:MM display strings (e.g. '8:54') calculated
// from the numeric minute buckets by the OT engine — report UIs render them
// directly without re-formatting. The numeric *Minutes fields remain the
// canonical values (Firestore persistence SSOT); the strings are additive.
export type OvertimeEntry = Partial<TimeEntry> & {
    workDate: string;
    totalWorkMinutes?: number;
    regularMinutes?: number;
    otMinutes?: number;
    doubleTimeMinutes?: number;
    weeklyOtAdjustment?: number;
    /** HH:MM display string of regularMinutes (set by the OT engine). */
    regularTime?: string;
    /** HH:MM display string of otMinutes (set by the OT engine). */
    otTime?: string;
    /** HH:MM display string of doubleTimeMinutes (set by the OT engine). */
    doubleTimeTime?: string;
    /** HH:MM display string of totalWorkMinutes (set by the OT engine). */
    totalTime?: string;
};

/**
 * Calculate weekly overtime adjustments
 * California Rule: >40h/week regular time becomes OT (don't double-count daily OT)
 * 
 * @param weekEntries - All entries for a workweek
 * @param workModel - Optional work model (overrides CA defaults)
 * @param workModelOverride - Optional per-user override (wins over workModel)
 * @returns Updated entries with weekly OT adjustments
 */
export function calculateWeeklyOvertimeAdjustments(
    weekEntries: OvertimeEntry[],
    workModel?: WorkModelDef | null,
    workModelOverride?: WorkModelOverride | null,
): OvertimeEntry[] {
    const rules = resolveOvertimeRules(workModel, workModelOverride);

    // First, ensure all entries have daily OT calculated
    const entriesWithDaily = weekEntries.map(entry => {
        if (!entry.regularMinutes && entry.totalWorkMinutes !== undefined) {
            // Calculate daily OT if not already done
            const dailyBreakdown = calculateDailyOvertimeBreakdown(entry.totalWorkMinutes, workModel, workModelOverride);
            return { ...entry, ...dailyBreakdown };
        }
        return entry;
    });

    // When noOvertime is set, daily breakdown already zeroed OT/DT; the weekly
    // >regularMax conversion is also skipped so nothing becomes OT.
    if (rules.noOvertime) {
        return entriesWithDaily.map(withHHMMDisplayFields);
    }

    // Sum up regular minutes for the week
    const totalRegularMinutes = entriesWithDaily.reduce((sum, entry) => {
        return sum + (entry.regularMinutes || 0);
    }, 0);

    // If weekly regular time exceeds the resolved cap, convert excess to OT
    if (totalRegularMinutes > rules.weeklyRegularMax) {
        const weeklyExcess = totalRegularMinutes - rules.weeklyRegularMax;

        // Reduce regular minutes and add to OT
        // Strategy: Take from the latest day first (LIFO approach)
        let remainingExcess = weeklyExcess;

        // Sort entries by date (latest first)
        const sortedEntries = [...entriesWithDaily].sort((a, b) =>
            b.workDate.localeCompare(a.workDate)
        );

        const adjustedEntries = sortedEntries.map(entry => {
            if (remainingExcess <= 0 || !entry.regularMinutes) {
                return entry;
            }

            // How much can we take from this day's regular time?
            const canTake = Math.min(entry.regularMinutes, remainingExcess);

            if (canTake > 0) {
                remainingExcess -= canTake;
                return {
                    ...entry,
                    regularMinutes: entry.regularMinutes - canTake,
                    otMinutes: (entry.otMinutes || 0) + canTake,
                    weeklyOtAdjustment: canTake // Track the adjustment
                };
            }

            return entry;
        });

        return adjustedEntries.map(withHHMMDisplayFields);
    }

    // No weekly OT needed
    return entriesWithDaily.map(withHHMMDisplayFields);
}

/**
 * Attach the direct HH:MM display strings (regularTime/otTime/doubleTimeTime/
 * totalTime) calculated from the entry's numeric minute buckets. The numeric
 * fields remain canonical; the strings are the report-display outputs.
 */
function withHHMMDisplayFields(entry: OvertimeEntry): OvertimeEntry {
    return {
        ...entry,
        regularTime: formatMinutesToHHMM(entry.regularMinutes || 0),
        otTime: formatMinutesToHHMM(entry.otMinutes || 0),
        doubleTimeTime: formatMinutesToHHMM(entry.doubleTimeMinutes || 0),
        totalTime: formatMinutesToHHMM(entry.totalWorkMinutes || 0),
    };
}

/**
 * Get all entries for a specific workweek
 * @param allEntries - All time entries
 * @param workWeekStartDate - Workweek start date
 * @returns Entries for that workweek
 */
export function getEntriesForWorkweek(allEntries: OvertimeEntry[], workWeekStartDate: string): OvertimeEntry[] {
    // PT-anchored date math: the input is a PT calendar date. We use Intl to
    // add 7 PT days without TZ misintrepretation.
    // Bug: previously used `new Date(workWeekStartDate + 'T00:00:00')` which on a
    // UTC server parsed as UTC midnight and gave wrong week boundaries.
    const [y, m, d] = workWeekStartDate.split('-').map(Number);
    if (!y || !m || !d) return [];

    const startStr = workWeekStartDate; // YYYY-MM-DD in PT = week start inclusive

    // Compute week end: add 7 PT days using a noon anchor to avoid any
    // midnight-boundary DST issues, then format the PT calendar day after adding.
    const endDate = new Date(Date.UTC(y, m - 1, d + 7, 12, 0, 0, 0));
    const endStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(endDate);

    return allEntries.filter(entry =>
        entry.workDate >= startStr && entry.workDate < endStr
    );
}

interface WeeklyTotals {
    regularMinutes: number;
    otMinutes: number;
    doubleTimeMinutes: number;
    totalMinutes: number;
}

interface BiweeklyTotals {
    grandTotals: WeeklyTotals;
    weeklyTotals: Record<string, WeeklyTotals>;
    adjustedEntries: OvertimeEntry[];
}

/**
 * Calculate OT for a date range (biweekly payroll)
 * @param entries - All entries in date range
 * @param workweekStartDay - Day workweek starts
 * @param workModel - Optional work model (overrides CA defaults)
 * @param workModelOverride - Optional per-user override (wins over workModel)
 * @returns Totals and per-workweek breakdown
 */
export function calculateBiweeklyOvertimeTotals(
    entries: OvertimeEntry[],
    workweekStartDay: number = DEFAULT_WORKWEEK_START_DAY,
    workModel?: WorkModelDef | null,
    workModelOverride?: WorkModelOverride | null,
): BiweeklyTotals {
    // Group entries by workweek
    const entriesByWorkweek: Record<string, OvertimeEntry[]> = {};

    entries.forEach(entry => {
        const weekStart = getWorkWeekStartDate(entry.workDate, workweekStartDay);
        if (!entriesByWorkweek[weekStart]) {
            entriesByWorkweek[weekStart] = [];
        }
        entriesByWorkweek[weekStart].push(entry);
    });

    // Calculate OT for each workweek
    const weeklyTotals: Record<string, WeeklyTotals> = {};
    const allAdjustedEntries: OvertimeEntry[] = [];

    Object.keys(entriesByWorkweek).forEach(weekStart => {
        const weekEntries = entriesByWorkweek[weekStart];
        const adjustedEntries = calculateWeeklyOvertimeAdjustments(weekEntries, workModel, workModelOverride);

        allAdjustedEntries.push(...adjustedEntries);

        // Calculate totals for this week
        const weekTotal = adjustedEntries.reduce((totals, entry) => {
            return {
                regularMinutes: totals.regularMinutes + (entry.regularMinutes || 0),
                otMinutes: totals.otMinutes + (entry.otMinutes || 0),
                doubleTimeMinutes: totals.doubleTimeMinutes + (entry.doubleTimeMinutes || 0),
                totalMinutes: totals.totalMinutes + (entry.totalWorkMinutes || 0)
            };
        }, {
            regularMinutes: 0,
            otMinutes: 0,
            doubleTimeMinutes: 0,
            totalMinutes: 0
        });

        weeklyTotals[weekStart] = weekTotal;
    });

    // Calculate grand totals across all workweeks
    const grandTotals = Object.values(weeklyTotals).reduce((totals, weekTotal) => {
        return {
            regularMinutes: totals.regularMinutes + weekTotal.regularMinutes,
            otMinutes: totals.otMinutes + weekTotal.otMinutes,
            doubleTimeMinutes: totals.doubleTimeMinutes + weekTotal.doubleTimeMinutes,
            totalMinutes: totals.totalMinutes + weekTotal.totalMinutes
        };
    }, {
        regularMinutes: 0,
        otMinutes: 0,
        doubleTimeMinutes: 0,
        totalMinutes: 0
    });

    return {
        grandTotals,
        weeklyTotals,
        adjustedEntries: allAdjustedEntries
    };
}

/**
 * Format minutes as a direct HH:MM duration string (e.g. 97:12, 18:12, 8:54,
 * 0:00). This is the canonical display output for calculated durations in the
 * Analytics and Payroll reports — hours are unpadded (may exceed 24), minutes
 * are zero-padded, negatives clamp to 0:00 (a duration is never negative).
 *
 * @param minutes - Raw minutes
 * @returns HH:MM string
 */
export function formatMinutesToHHMM(minutes: number): string {
    const totalMinutes = Math.max(0, Math.round(Number(minutes) || 0));
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * Get OT summary for display. Returns direct HH:MM strings calculated from
 * the raw minute totals (e.g. { regular: '36:12', overtime: '4:30', ... }).
 *
 * @param totals - { regularMinutes, otMinutes, doubleTimeMinutes }
 * @returns HH:MM-formatted summary
 */
export function getOvertimeSummary(totals: WeeklyTotals) {
    return {
        regular: formatMinutesToHHMM(totals.regularMinutes),
        overtime: formatMinutesToHHMM(totals.otMinutes),
        doubleTime: formatMinutesToHHMM(totals.doubleTimeMinutes),
        total: formatMinutesToHHMM(
            totals.regularMinutes + totals.otMinutes + totals.doubleTimeMinutes
        )
    };
}
