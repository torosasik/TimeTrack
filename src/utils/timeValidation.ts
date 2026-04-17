/**
 * Time Validation Helpers
 * Ensures logical time entry and prevents negative hours
 */

/**
 * Convert time string to minutes since midnight
 * @param timeStr - Time in HH:MM format
 * @returns Minutes since midnight
 */
export function timeToMinutes(timeStr: string | null | undefined): number {
    if (!timeStr) return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

/**
 * Validate that time2 is after time1
 * @param time1 - Earlier time (HH:MM)
 * @param time2 - Later time (HH:MM)
 * @returns True if time2 > time1
 */
export function isTimeAfter(time1: string, time2: string): boolean {
    return timeToMinutes(time2) > timeToMinutes(time1);
}

interface ValidationResult {
    valid: boolean;
    message?: string;
}

/**
 * Validate Clock In time
 * @param clockIn - Clock in time
 * @returns { valid, message }
 */
export function validateClockIn(clockIn: string): ValidationResult {
    if (!clockIn) {
        return { valid: false, message: 'Please enter clock in time' };
    }

    // Basic validation - just needs to be a valid time
    return { valid: true };
}

/**
 * Validate Lunch Out time
 * @param lunchOut - Lunch out time
 * @param clockIn - Clock in time (reference)
 * @returns { valid, message }
 */
export function validateLunchOut(lunchOut: string, clockIn: string): ValidationResult {
    if (!lunchOut) {
        return { valid: false, message: 'Please enter lunch out time or skip lunch' };
    }

    if (!clockIn) {
        return { valid: false, message: 'Clock in time not found' };
    }

    // Lunch out must be after clock in
    if (!isTimeAfter(clockIn, lunchOut)) {
        return {
            valid: false,
            message: `Lunch out (${lunchOut}) must be after clock in (${clockIn})`
        };
    }

    return { valid: true };
}

/**
 * Validate Lunch In time
 * @param lunchIn - Lunch in time
 * @param lunchOut - Lunch out time (reference)
 * @returns { valid, message }
 */
export function validateLunchIn(lunchIn: string, lunchOut: string): ValidationResult {
    if (!lunchIn) {
        return { valid: false, message: 'Please enter lunch in time' };
    }

    if (!lunchOut) {
        return { valid: false, message: 'Lunch out time not found' };
    }

    // Lunch in must be after lunch out
    if (!isTimeAfter(lunchOut, lunchIn)) {
        return {
            valid: false,
            message: `Lunch in (${lunchIn}) must be after lunch out (${lunchOut})`
        };
    }

    return { valid: true };
}

/**
 * Validate Clock Out time
 * @param clockOut - Clock out time
 * @param clockIn - Clock in time (reference)
 * @param lunchIn - Lunch in time (optional)
 * @returns { valid, message }
 */
export function validateClockOut(clockOut: string, clockIn: string, lunchIn: string | null = null): ValidationResult {
    if (!clockOut) {
        return { valid: false, message: 'Please enter clock out time' };
    }

    if (!clockIn) {
        return { valid: false, message: 'Clock in time not found' };
    }

    // Clock out must be after clock in
    if (!isTimeAfter(clockIn, clockOut)) {
        return {
            valid: false,
            message: `Clock out (${clockOut}) must be after clock in (${clockIn})`
        };
    }

    // If lunch was taken, clock out must be after lunch in
    if (lunchIn && !isTimeAfter(lunchIn, clockOut)) {
        return {
            valid: false,
            message: `Clock out (${clockOut}) must be after lunch in (${lunchIn})`
        };
    }

    return { valid: true };
}

interface TimeEntryManual {
    clockInManual: string;
    lunchOutManual?: string;
    lunchInManual?: string;
    clockOutManual?: string;
}

interface SequenceValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validate entire time entry sequence
 * @param entry - Entry object with all times
 * @returns { valid, errors }
 */
export function validateTimeSequence(entry: TimeEntryManual): SequenceValidationResult {
    const errors: string[] = [];

    const clockIn = entry.clockInManual;
    const lunchOut = entry.lunchOutManual;
    const lunchIn = entry.lunchInManual;
    const clockOut = entry.clockOutManual;

    // Clock in validation
    if (!clockIn) {
        errors.push('Clock in is required');
    }

    // Lunch validation
    if (lunchOut && !lunchIn) {
        errors.push('Lunch in is required if lunch out is entered');
    }

    if (lunchIn && !lunchOut) {
        errors.push('Lunch out is required if lunch in is entered');
    }

    // Sequential validation
    if (clockIn && lunchOut && !isTimeAfter(clockIn, lunchOut)) {
        errors.push(`Lunch out must be after clock in`);
    }

    if (lunchOut && lunchIn && !isTimeAfter(lunchOut, lunchIn)) {
        errors.push(`Lunch in must be after lunch out`);
    }

    if (clockIn && clockOut && !isTimeAfter(clockIn, clockOut)) {
        errors.push(`Clock out must be after clock in`);
    }

    if (lunchIn && clockOut && !isTimeAfter(lunchIn, clockOut)) {
        errors.push(`Clock out must be after lunch in`);
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

interface StepTimes {
    clockIn?: string;
    lunchOut?: string;
    lunchIn?: string;
}

/**
 * Get minimum time for an input based on previous step
 * @param step - Current step (lunchOut, lunchIn, clockOut)
 * @param previousTimes - Object with previous times
 * @returns Minimum time in HH:MM format, or null
 */
export function getMinTimeForStep(step: 'lunchOut' | 'lunchIn' | 'clockOut', previousTimes: StepTimes): string | null {
    switch (step) {
        case 'lunchOut':
            return previousTimes.clockIn || null;
        case 'lunchIn':
            return previousTimes.lunchOut || null;
        case 'clockOut':
            // Must be after lunch in (if exists) or clock in
            return previousTimes.lunchIn || previousTimes.clockIn || null;
        default:
            return null;
    }
}

/**
 * Format time with AM/PM
 * @param time - Time in HH:MM format
 * @returns Time with AM/PM
 */
export function formatTimeWithAMPM(time: string): string {
    if (!time) return '';

    const [hours, minutes] = time.split(':').map(Number);
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;

    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
}

export interface AnomalyResult {
    hasAnomaly: boolean;
    message?: string;
}

/**
 * Check for unusual time entries that warrant a warning/confirmation
 * @param step - Current step index (0 = Clock In, 1 = Lunch Out, 2 = Lunch In, 3 = Clock Out)
 * @param time - Current time string (HH:MM)
 * @param workDate - Entry date (YYYY-MM-DD)
 * @param entry - The current TimeEntry object (for comparing previous times)
 * @returns { hasAnomaly, message }
 */
export function checkTimeAnomalies(
    step: number | 'complete',
    time: string,
    workDate: string,
    entry: any
): AnomalyResult {
    if (!time || step === 'complete') return { hasAnomaly: false };

    const timeMins = timeToMinutes(time);

    const standardWarningMessage = "This entry looks unusual. Please confirm that this is correct.";

    // 1. Weekend Check
    try {
        const date = new Date(workDate + 'T00:00:00');
        const day = date.getDay();
        if (day === 0 || day === 6) { // Sunday or Saturday
            return {
                hasAnomaly: true,
                message: standardWarningMessage
            };
        }
    } catch (e) { /* ignore date parse errors */ }

    // 2. Early Arrival Check (Before 6:00 AM)
    if (step === 0) { // Clock In
        if (timeMins < 6 * 60) {
            return {
                hasAnomaly: true,
                message: standardWarningMessage
            };
        }
    }

    // 3. Late Departure Check (After 6:00 PM)
    if (step === 3) { // Clock Out
        if (timeMins > 18 * 60) {
            return {
                hasAnomaly: true,
                message: standardWarningMessage
            };
        }
    }

    // 4. Short Interval Check (Less than 1 hour between Clock In and Lunch Out/Clock Out)
    if (entry && entry.clockInManual && (step === 1 || step === 3)) {
        const clockInMins = timeToMinutes(entry.clockInManual);
        const diffMins = timeMins - clockInMins;

        if (diffMins > 0 && diffMins < 60) {
            return {
                hasAnomaly: true,
                message: standardWarningMessage
            };
        }
    }

    // 5. Very Long Shift Check (More than 12 hours between Clock In and Clock Out)
    if (entry && entry.clockInManual && step === 3) {
        const clockInMins = timeToMinutes(entry.clockInManual);
        const shiftDuration = timeMins - clockInMins;

        if (shiftDuration > 12 * 60) {
            return {
                hasAnomaly: true,
                message: `This entry looks unusual (shift is over 12 hours). Please confirm that this is correct.`
            };
        }
    }

    return { hasAnomaly: false };
}
