/**
 * Work Schedule Configuration & Red Flag Detection
 */

// Work schedule types
export const SCHEDULE_TYPES = {
    FULL_TIME: 'full-time',
    PART_TIME: 'part-time',
    REMOTE: 'remote',
    FREELANCE: 'freelance'
};

// Red flag types
export const RED_FLAGS = {
    LATE_ARRIVAL: 'LATE_ARRIVAL',
    LEFT_EARLY: 'LEFT_EARLY',
    STAYED_LATE: 'STAYED_LATE',
    SHORT_LUNCH: 'SHORT_LUNCH',
    LONG_LUNCH: 'LONG_LUNCH',
    WRONG_DAY: 'WRONG_DAY'
};

// Default work schedule for full-time employees
export const DEFAULT_FULL_TIME_SCHEDULE = {
    type: SCHEDULE_TYPES.FULL_TIME,
    timezone: 'America/Los_Angeles',
    workDays: [1, 2, 3, 4, 5], // Monday-Friday
    startTime: '08:00',
    endTime: '17:00',
    expectedLunchMin: 30,
    expectedLunchMax: 60,
    lateThresholdMinutes: 15,
    earlyLeaveThresholdMinutes: 15,
    stayLateThresholdMinutes: 30
};

/**
 * Convert time string to minutes since midnight
 */
function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

/**
 * Calculate time difference in minutes
 */
function timeDifferenceMinutes(time1, time2) {
    return Math.abs(timeToMinutes(time1) - timeToMinutes(time2));
}

/**
 * Check if employee arrived late
 */
export function checkLateArrival(clockIn, schedule) {
    if (!schedule || schedule.type === SCHEDULE_TYPES.FREELANCE) return null;
    if (!clockIn || !schedule.startTime) return null;

    const scheduledStart = timeToMinutes(schedule.startTime);
    const actualStart = timeToMinutes(clockIn);
    const lateMinutes = actualStart - scheduledStart;

    const threshold = schedule.lateThresholdMinutes || 15;

    if (lateMinutes > threshold) {
        return {
            type: RED_FLAGS.LATE_ARRIVAL,
            severity: 'high',
            minutes: lateMinutes,
            message: `Late arrival: ${lateMinutes} minutes after scheduled start`
        };
    }

    return null;
}

/**
 * Check if employee left early
 */
export function checkLeftEarly(clockOut, schedule) {
    if (!schedule || schedule.type === SCHEDULE_TYPES.FREELANCE) return null;
    if (!clockOut || !schedule.endTime) return null;

    const scheduledEnd = timeToMinutes(schedule.endTime);
    const actualEnd = timeToMinutes(clockOut);
    const earlyMinutes = scheduledEnd - actualEnd;

    const threshold = schedule.earlyLeaveThresholdMinutes || 15;

    if (earlyMinutes > threshold) {
        return {
            type: RED_FLAGS.LEFT_EARLY,
            severity: 'high',
            minutes: earlyMinutes,
            message: `Left early: ${earlyMinutes} minutes before scheduled end`
        };
    }

    return null;
}

/**
 * Check if employee stayed late
 */
export function checkStayedLate(clockOut, schedule) {
    if (!schedule || schedule.type === SCHEDULE_TYPES.FREELANCE) return null;
    if (!clockOut || !schedule.endTime) return null;

    const scheduledEnd = timeToMinutes(schedule.endTime);
    const actualEnd = timeToMinutes(clockOut);
    const lateMinutes = actualEnd - scheduledEnd;

    const threshold = schedule.stayLateThresholdMinutes || 30;

    if (lateMinutes > threshold) {
        return {
            type: RED_FLAGS.STAYED_LATE,
            severity: 'medium',
            minutes: lateMinutes,
            message: `Stayed late: ${lateMinutes} minutes after scheduled end`
        };
    }

    return null;
}

/**
 * Check if working on wrong day
 */
export function checkWrongDay(workDate, schedule) {
    if (!schedule || schedule.type === SCHEDULE_TYPES.FREELANCE) return null;
    if (!schedule.workDays || !workDate) return null;

    const date = new Date(workDate);
    const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday

    if (!schedule.workDays.includes(dayOfWeek)) {
        return {
            type: RED_FLAGS.WRONG_DAY,
            severity: 'medium',
            message: `Working on non-scheduled day`
        };
    }

    return null;
}

/**
 * Check all red flags for an entry
 */
export function checkAllRedFlags(entry, userSchedule) {
    const flags = [];

    // Use default schedule if none provided
    const schedule = userSchedule || DEFAULT_FULL_TIME_SCHEDULE;

    // Skip all checks for freelancers
    if (schedule.type === SCHEDULE_TYPES.FREELANCE) {
        return flags;
    }

    // Check late arrival
    const lateFlag = checkLateArrival(entry.clockInManual, schedule);
    if (lateFlag) flags.push(lateFlag);

    // Check left early
    const earlyFlag = checkLeftEarly(entry.clockOutManual, schedule);
    if (earlyFlag) flags.push(earlyFlag);

    // Check stayed late
    const stayLateFlag = checkStayedLate(entry.clockOutManual, schedule);
    if (stayLateFlag) flags.push(stayLateFlag);

    // Check wrong day
    const wrongDayFlag = checkWrongDay(entry.workDate, schedule);
    if (wrongDayFlag) flags.push(wrongDayFlag);

    // Check lunch duration (from existing warnings)
    if (entry.warnings && entry.warnings.length > 0) {
        entry.warnings.forEach(warning => {
            if (warning === 'SHORT_LUNCH') {
                flags.push({
                    type: RED_FLAGS.SHORT_LUNCH,
                    severity: 'medium',
                    message: 'Lunch less than 30 minutes'
                });
            } else if (warning === 'LONG_LUNCH') {
                flags.push({
                    type: RED_FLAGS.LONG_LUNCH,
                    severity: 'medium',
                    message: 'Lunch exceeds 60 minutes'
                });
            }
        });
    }

    return flags;
}

/**
 * Get red flag icon
 */
export function getRedFlagIcon(flag) {
    const icons = {
        [RED_FLAGS.LATE_ARRIVAL]: '🔴',
        [RED_FLAGS.LEFT_EARLY]: '🔴',
        [RED_FLAGS.STAYED_LATE]: '🟡',
        [RED_FLAGS.SHORT_LUNCH]: '⚠️',
        [RED_FLAGS.LONG_LUNCH]: '⚠️',
        [RED_FLAGS.WRONG_DAY]: '🟠'
    };

    return icons[flag.type] || '⚠️';
}

/**
 * Get red flag color class
 */
export function getRedFlagClass(flag) {
    if (flag.severity === 'high') return 'flag-high';
    if (flag.severity === 'medium') return 'flag-medium';
    return 'flag-low';
}
