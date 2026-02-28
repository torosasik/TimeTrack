/**
 * Time Calculation Functions
 */

import { TimeEntry } from '../app/lib/database';

/**
 * Convert HH:MM time string to minutes since midnight
 * @param timeStr - Time string in HH:MM format
 * @returns Minutes since midnight
 */
export function timeToMinutes(timeStr: string | undefined | null): number {
    if (!timeStr || timeStr.trim() === '') return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

/**
 * Convert minutes to HH:MM format
 * @param minutes - Total minutes
 * @returns Time in HH:MM format
 */
export function minutesToTime(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Calculate lunch duration in minutes
 * @param lunchOut - Lunch out time (HH:MM)
 * @param lunchIn - Lunch in time (HH:MM)
 * @returns Lunch duration in minutes
 */
export function calculateLunchMinutes(lunchOut: string, lunchIn: string): number {
    if (!lunchOut || !lunchIn) return 0;
    const outMinutes = timeToMinutes(lunchOut);
    const inMinutes = timeToMinutes(lunchIn);
    return inMinutes - outMinutes;
}

/**
 * Calculate total work minutes
 * @param clockIn - Clock in time (HH:MM)
 * @param clockOut - Clock out time (HH:MM)
 * @param lunchMinutes - Lunch duration in minutes
 * @returns Total work minutes
 */
export function calculateTotalWorkMinutes(clockIn: string, clockOut: string, lunchMinutes: number): number {
    if (!clockIn || !clockOut) return 0;
    const inMinutes = timeToMinutes(clockIn);
    const outMinutes = timeToMinutes(clockOut);
    const totalMinutes = outMinutes - inMinutes;
    return totalMinutes - lunchMinutes;
}

/**
 * Format minutes to "Xh Ym" display format
 * @param minutes - Total minutes
 * @returns Formatted as "Xh Ym"
 */
export function formatMinutesToHoursMinutes(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
}

/**
 * Convert minutes to decimal hours (for admin view)
 * @param minutes - Total minutes
 * @returns Decimal hours (e.g., "8.5")
 */
export function minutesToDecimalHours(minutes: number): string {
    return (minutes / 60).toFixed(2);
}

/**
 * Validate time entry and return array of errors
 * @param entry - Time entry object
 * @returns Array of error messages
 */
export function validateTimeEntry(entry: Partial<TimeEntry>): string[] {
    const errors: string[] = [];

    const clockIn = timeToMinutes(entry.clockInManual);
    const clockOut = timeToMinutes(entry.clockOutManual);
    const lunchOut = timeToMinutes(entry.lunchOutManual);
    const lunchIn = timeToMinutes(entry.lunchInManual);

    // Check if clock out is after clock in
    if (clockOut <= clockIn) {
        errors.push('Clock out must be after clock in');
    }

    // Check lunch times if provided
    const hasLunchOut = entry.lunchOutManual && entry.lunchOutManual.trim() !== '';
    const hasLunchIn = entry.lunchInManual && entry.lunchInManual.trim() !== '';

    // Both lunch times required or neither
    if (hasLunchOut !== hasLunchIn) {
        errors.push('Both lunch times required or leave both empty');
    }

    if (hasLunchOut && hasLunchIn) {
        // Lunch out must be after clock in
        if (lunchOut <= clockIn) {
            errors.push('Lunch out must be after clock in');
        }

        // Lunch in must be after lunch out
        if (lunchIn <= lunchOut) {
            errors.push('Lunch in must be after lunch out');
        }

        // Clock out must be after lunch in
        if (clockOut <= lunchIn) {
            errors.push('Clock out must be after lunch in');
        }
    }

    return errors;
}

/**
 * Check for lunch warnings (red flags)
 * @param lunchMinutes - Lunch duration in minutes
 * @returns Array of warning types
 */
export function checkLunchWarnings(lunchMinutes: number): string[] {
    const warnings: string[] = [];

    if (lunchMinutes > 60) {
        warnings.push('lunch_too_long');
    }

    if (lunchMinutes > 0 && lunchMinutes < 30) {
        warnings.push('lunch_too_short');
    }

    return warnings;
}

/**
 * Get human-readable warning message
 * @param warningType - Warning type code
 * @returns Human-readable message
 */
export function getWarningMessage(warningType: string): string {
    const messages: Record<string, string> = {
        'lunch_too_long': '⚠️ Lunch exceeds 60 minutes',
        'lunch_too_short': '⚠️ Lunch less than 30 minutes'
    };
    return messages[warningType] || warningType;
}
