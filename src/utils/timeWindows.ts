/**
 * Time Window & Deadline Enforcement
 * Prevents late entries and enforces completion deadlines
 */

import { TimeEntry } from '../app/lib/database';

interface TimeWindowResult {
    allowed: boolean;
    reason?: string; // Reason for blockage (machine readable)
    message?: string; // Human readable message
    gracePeriod?: boolean;
    warningMessage?: string; // Warning message text
}

/**
 * Check if entry is within allowed time window
 * Rules:
 * - Same calendar day: Always allowed
 * - Next day before 10am: Allowed (grace period)
 * - After 10am next day: LOCKED
 * 
 * @param workDate - Entry date (YYYY-MM-DD)
 * @param currentTime - Current time
 * @returns { allowed, reason }
 */
export function isWithinTimeWindow(workDate: string, currentTime: Date = new Date()): TimeWindowResult {
    const entryDate = new Date(workDate + 'T00:00:00');
    const now = currentTime;

    // Get dates without time
    const entryDay = new Date(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate());
    const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const daysDiff = Math.floor((nowDay.getTime() - entryDay.getTime()) / (1000 * 60 * 60 * 24));

    // Same day - always allowed
    if (daysDiff === 0) {
        return { allowed: true };
    }

    // Next day (1 day later)
    if (daysDiff === 1) {
        const currentHour = now.getHours();

        // Before 10am = grace period
        if (currentHour < 10) {
            return {
                allowed: true,
                gracePeriod: true,
                message: `Grace period: Entry must be completed by 10:00 AM today`
            };
        } else {
            return {
                allowed: true, // Temporarily allowing entries after 10 AM
                reason: 'time_window_closed_warning',
                warningMessage: 'Warning: Time entered after 10:00 AM deadline. Please try to complete your entries on time in the future.'
            };
        }
    }

    // More than 1 day old
    return {
        allowed: true, // Temporarily allowing old entries
        reason: 'entry_too_old_warning',
        warningMessage: 'Warning: Time entered past the deadline. Please try to complete your entries on time in the future.'
    };
}

/**
 * Check if entry is past completion deadline
 * Deadline: 11:59 PM same day OR 10:00 AM next day
 * 
 * @param workDate - Entry date
 * @param currentTime - Current time
 * @returns True if past deadline
 */
export function isPastDeadline(workDate: string, currentTime: Date = new Date()): boolean {
    const window = isWithinTimeWindow(workDate, currentTime);
    // Since we relaxed allowed=true, we detect deadline violation via reason flag
    return !window.allowed || window.reason?.includes('warning') === true;
}

/**
 * Get yesterday's date in YYYY-MM-DD format
 * @param fromDate - Reference date (default: today)
 * @returns Yesterday's date
 */
export function getYesterdayDate(fromDate: Date = new Date()): string {
    const yesterday = new Date(fromDate);
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
}

interface CompletionCheckResult {
    complete: boolean;
    reason?: string;
    message?: string;
}

// Partial entry type for this specific check, usually the raw firestore data or typed TimeEntry
type CheckEntry = Partial<TimeEntry> & {
    dayComplete?: boolean;
};

/**
 * Check if yesterday's entry is complete
 * Used to block today's entry if yesterday is incomplete
 * 
 * @param yesterdayEntry - Yesterday's time entry
 * @returns { complete, reason }
 */
export function isYesterdayComplete(yesterdayEntry: CheckEntry | null | undefined): CompletionCheckResult {
    // No entry at all (e.g., first day, weekend, or day off)
    if (!yesterdayEntry) {
        return { complete: true };
    }

    // Entry exists but not complete
    if (!yesterdayEntry.dayComplete && !yesterdayEntry.complete) {
        return {
            complete: false,
            reason: 'incomplete',
            message: 'You must complete your previous day before starting a new one.'
        };
    }

    // Entry exists but missing clock out - checking manually just in case flag is wrong
    if (!yesterdayEntry.clockOutManual) {
        return {
            complete: false,
            reason: 'no_clock_out',
            message: 'You must complete your previous day before starting a new one.'
        };
    }

    // All good
    return { complete: true };
}

/**
 * Format time window message for display
 * @param workDate - Entry date
 * @returns Human-readable message
 */
export function getTimeWindowMessage(workDate: string): string | null {
    const window = isWithinTimeWindow(workDate);

    if (!window.allowed) {
        return window.message || null;
    }

    if (window.gracePeriod) {
        return `⏰ Grace Period: Complete by 10:00 AM today`;
    }

    return null;
}

/**
 * Calculate hours until deadline
 * @param workDate - Entry date
 * @param currentTime - Current time
 * @returns Hours until deadline, or null if past
 */
export function getHoursUntilDeadline(workDate: string, currentTime: Date = new Date()): number | null {
    const entryDate = new Date(workDate + 'T00:00:00');
    const deadline = new Date(entryDate);
    deadline.setDate(deadline.getDate() + 1);
    deadline.setHours(10, 0, 0, 0); // 10am next day

    const now = currentTime;
    const hoursRemaining = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);

    return hoursRemaining > 0 ? hoursRemaining : null;
}

/**
 * Check if it's a weekend
 * @param dateStr - Date in YYYY-MM-DD
 * @returns True if Saturday or Sunday
 */
export function isWeekend(dateStr: string): boolean {
    const date = new Date(dateStr + 'T00:00:00');
    const day = date.getDay();
    return day === 0 || day === 6; // Sunday or Saturday
}

/**
 * Get next business day (skip weekends)
 * @param dateStr - Starting date
 * @returns Next business day in YYYY-MM-DD
 */
export function getNextBusinessDay(dateStr: string): string {
    const date = new Date(dateStr + 'T00:00:00');
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);

    // Skip weekends
    while (isWeekend(nextDay.toISOString().split('T')[0])) {
        nextDay.setDate(nextDay.getDate() + 1);
    }

    return nextDay.toISOString().split('T')[0];
}

/**
 * Get previous business day (skip weekends)
 * @param dateStr - Starting date
 * @returns Previous business day in YYYY-MM-DD
 */
export function getPreviousBusinessDay(dateStr: string): string {
    const date = new Date(dateStr + 'T00:00:00');
    const prevDay = new Date(date);
    prevDay.setDate(prevDay.getDate() - 1);

    // Skip weekends
    while (isWeekend(prevDay.toISOString().split('T')[0])) {
        prevDay.setDate(prevDay.getDate() - 1);
    }

    return prevDay.toISOString().split('T')[0];
}

interface AccessCheckResult {
    canAccess: boolean;
    blocked: boolean;
    reason?: string;
    message?: string;
    showSummary?: boolean;
    gracePeriod?: boolean;
    graceMessage?: string;
    warningMessage?: string;
}

interface CheckEntryAccessParams {
    workDate: string;
    yesterdayEntry: CheckEntry | null;
    currentEntry: CheckEntry | null;
}

/**
 * Comprehensive entry access check
 * Combines all rules: time window, yesterday blocking, deadlines
 * 
 * @param params - { workDate, yesterdayEntry, currentEntry }
 * @returns { canAccess, blocked, reason, message }
 */
export function checkEntryAccess(params: CheckEntryAccessParams): AccessCheckResult {
    const { workDate, yesterdayEntry, currentEntry } = params;

    // Check if entry is complete and locked
    // Checking both flag variations (legacy vs new)
    if (currentEntry && (currentEntry.dayComplete || currentEntry.complete)) {
        return {
            canAccess: false,
            blocked: true,
            reason: 'entry_complete',
            message: 'This entry is complete and locked. Contact a manager for corrections.',
            showSummary: true
        };
    }

    // Check time window
    const window = isWithinTimeWindow(workDate);
    if (!window.allowed) {
        return {
            canAccess: false,
            blocked: true,
            reason: 'time_window_closed',
            message: window.message
        };
    }

    // Check yesterday's completion - TEMPORARILY DISABLED AS BLOCKER, NOW A WARNING
    const yesterdayCheck = isYesterdayComplete(yesterdayEntry);

    // Aggregate warnings
    let warningText = window.warningMessage || '';
    if (!yesterdayCheck.complete) {
        warningText = warningText
            ? warningText + ' ' + 'Reminder: You forgot to clock out yesterday.'
            : 'Reminder: You forgot to clock out yesterday. Please request a manager correction for your previous shift.';
    }

    // All checks passed (or resolved to warnings)
    return {
        canAccess: true,
        blocked: false,
        gracePeriod: window.gracePeriod || false,
        graceMessage: window.message,
        warningMessage: warningText || undefined
    };
}
