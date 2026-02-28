/**
 * California Overtime Calculation Engine
 * 
 * Rules:
 * - Daily: 0-8h = Regular, 8-12h = OT (1.5×), >12h = Double Time (2×)
 * - Weekly: >40h regular = OT (don't double-count daily OT)
 * - Biweekly payroll: Sum across two workweeks
 */

import { TimeEntry } from '../app/lib/database';

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

// Default workweek starts on Sunday
export const DEFAULT_WORKWEEK_START_DAY = WORKWEEK_START_DAYS.SUNDAY;

// Time thresholds in minutes
const DAILY_REGULAR_MAX = 480;      // 8 hours
const DAILY_OT_MAX = 720;           // 12 hours
const WEEKLY_REGULAR_MAX = 2400;    // 40 hours

/**
 * Calculate workweek start date for a given date
 * @param dateStr - Date in YYYY-MM-DD format
 * @param workweekStartDay - Day of week workweek starts (0=Sunday)
 * @returns Workweek start date in YYYY-MM-DD format
 */
export function getWorkWeekStartDate(dateStr: string, workweekStartDay: number = DEFAULT_WORKWEEK_START_DAY): string {
    const date = new Date(dateStr + 'T00:00:00');
    const dayOfWeek = date.getDay();

    // Calculate how many days back to the workweek start
    let daysBack = (dayOfWeek - workweekStartDay + 7) % 7;

    // Go back to workweek start
    const workweekStart = new Date(date);
    workweekStart.setDate(date.getDate() - daysBack);

    return workweekStart.toISOString().split('T')[0];
}

interface DailyOvertimeBreakdown {
    regularMinutes: number;
    otMinutes: number;
    doubleTimeMinutes: number;
}

/**
 * Calculate daily overtime breakdown
 * California Rule: 0-8h regular, 8-12h OT, >12h double time
 * 
 * @param totalWorkMinutes - Total work minutes for the day
 * @returns { regularMinutes, otMinutes, doubleTimeMinutes }
 */
export function calculateDailyOvertimeBreakdown(totalWorkMinutes: number): DailyOvertimeBreakdown {
    let regularMinutes = 0;
    let otMinutes = 0;
    let doubleTimeMinutes = 0;

    if (totalWorkMinutes <= DAILY_REGULAR_MAX) {
        // All regular time (0-8 hours)
        regularMinutes = totalWorkMinutes;
    } else if (totalWorkMinutes <= DAILY_OT_MAX) {
        // Regular + OT (8-12 hours)
        regularMinutes = DAILY_REGULAR_MAX;
        otMinutes = totalWorkMinutes - DAILY_REGULAR_MAX;
    } else {
        // Regular + OT + Double Time (>12 hours)
        regularMinutes = DAILY_REGULAR_MAX;
        otMinutes = DAILY_OT_MAX - DAILY_REGULAR_MAX; // 240 minutes (4 hours)
        doubleTimeMinutes = totalWorkMinutes - DAILY_OT_MAX;
    }

    return {
        regularMinutes,
        otMinutes,
        doubleTimeMinutes
    };
}

// Partial TimeEntry with enough info for overtime calcs, plus the optional weekly adjustment field
type OvertimeEntry = Partial<TimeEntry> & {
    workDate: string;
    totalWorkMinutes?: number;
    regularMinutes?: number;
    otMinutes?: number;
    doubleTimeMinutes?: number;
    weeklyOtAdjustment?: number;
};

/**
 * Calculate weekly overtime adjustments
 * California Rule: >40h/week regular time becomes OT (don't double-count daily OT)
 * 
 * @param weekEntries - All entries for a workweek
 * @returns Updated entries with weekly OT adjustments
 */
export function calculateWeeklyOvertimeAdjustments(weekEntries: OvertimeEntry[]): OvertimeEntry[] {
    // First, ensure all entries have daily OT calculated
    const entriesWithDaily = weekEntries.map(entry => {
        if (!entry.regularMinutes && entry.totalWorkMinutes !== undefined) {
            // Calculate daily OT if not already done
            const dailyBreakdown = calculateDailyOvertimeBreakdown(entry.totalWorkMinutes);
            return { ...entry, ...dailyBreakdown };
        }
        return entry;
    });

    // Sum up regular minutes for the week
    const totalRegularMinutes = entriesWithDaily.reduce((sum, entry) => {
        return sum + (entry.regularMinutes || 0);
    }, 0);

    // If weekly regular time exceeds 40 hours, convert excess to OT
    if (totalRegularMinutes > WEEKLY_REGULAR_MAX) {
        const weeklyExcess = totalRegularMinutes - WEEKLY_REGULAR_MAX;

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
                return {
                    ...entry,
                    regularMinutes: entry.regularMinutes - canTake,
                    otMinutes: (entry.otMinutes || 0) + canTake,
                    weeklyOtAdjustment: canTake // Track the adjustment
                };
            }

            return entry;
        });

        // Update remaining excess
        remainingExcess -= weeklyExcess;

        return adjustedEntries;
    }

    // No weekly OT needed
    return entriesWithDaily;
}

/**
 * Get all entries for a specific workweek
 * @param allEntries - All time entries
 * @param workWeekStartDate - Workweek start date
 * @returns Entries for that workweek
 */
export function getEntriesForWorkweek(allEntries: OvertimeEntry[], workWeekStartDate: string): OvertimeEntry[] {
    const weekStart = new Date(workWeekStartDate + 'T00:00:00');
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);

    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    return allEntries.filter(entry =>
        entry.workDate >= weekStartStr && entry.workDate < weekEndStr
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
 * @returns Totals and per-workweek breakdown
 */
export function calculateBiweeklyOvertimeTotals(entries: OvertimeEntry[], workweekStartDay: number = DEFAULT_WORKWEEK_START_DAY): BiweeklyTotals {
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
        const adjustedEntries = calculateWeeklyOvertimeAdjustments(weekEntries);

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
 * Format minutes to hours with 2 decimals
 * @param minutes
 * @returns Hours with 2 decimal places
 */
export function formatMinutesToHoursDecimal(minutes: number): string {
    const hours = minutes / 60;
    return hours.toFixed(2);
}

/**
 * Get OT summary for display
 * @param totals - { regularMinutes, otMinutes, doubleTimeMinutes }
 * @returns Formatted summary
 */
export function getOvertimeSummary(totals: WeeklyTotals) {
    return {
        regular: formatMinutesToHoursDecimal(totals.regularMinutes),
        overtime: formatMinutesToHoursDecimal(totals.otMinutes),
        doubleTime: formatMinutesToHoursDecimal(totals.doubleTimeMinutes),
        total: formatMinutesToHoursDecimal(
            totals.regularMinutes + totals.otMinutes + totals.doubleTimeMinutes
        )
    };
}
