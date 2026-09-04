/**
 * Date Helper Functions
 *
 * IMPORTANT: All payroll-affecting dates are in America/Los_Angeles (PT).
 * Never use browser Date directly. Use Intl.DateTimeFormat with timeZone.
 */

/**
 * Get yesterday's date in YYYY-MM-DD format (PT timezone).
 * @param {Date} [fromDate] - Optional reference date (defaults to now)
 * @returns {string} Yesterday's date in PT
 */
export function getYesterdayDate(fromDate) {
    const now = fromDate ?? new Date();
    return getPTDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

/**
 * Get today's date in YYYY-MM-DD format (PT timezone).
 * @returns {string} Today's date in PT
 */
export function getTodayDate() {
    return getPTDate(new Date());
}

/**
 * Return the PT (America/Los_Angeles) YYYY-MM-DD for a given Date instant.
 * Used internally to anchor all payroll dates to PT.
 * @param {Date} d
 * @returns {string}
 */
function getPTDate(d) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

/**
 * Format a date object to YYYY-MM-DD string (PT timezone).
 * @param {Date} date - Date object (will be interpreted in PT)
 * @returns {string} Formatted date
 */
export function formatDateYYYYMMDD(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

/**
 * Check if a time entry is complete (has clock out time)
 * @param {Object} entry - Time entry object
 * @returns {boolean} True if entry has clockOutManual
 */
export function isEntryComplete(entry) {
    return entry && entry.clockOutManual && entry.clockOutManual.trim() !== '';
}

/**
 * Parse YYYY-MM-DD string to a UTC-anchored Date (midnight UTC).
 * Use this when the YYYY-MM-DD is a calendar date (no timezone).
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {Date} UTC midnight Date
 */
export function parseDate(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Format date to display format (e.g., "Monday, Dec 15, 2025") in PT.
 * YYYY-MM-DD is interpreted as a PT calendar day (anchored at noon UTC to
 * avoid any off-by-one from DST transitions).
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {string} Formatted date string
 */
export function formatDateDisplay(dateStr) {
    const options = {
        timeZone: 'America/Los_Angeles',
        weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
    };
    const date = new Date(dateStr + 'T12:00:00Z');
    return new Intl.DateTimeFormat('en-US', options).format(date);
}

/**
 * Format a YYYY-MM-DD date as MM/DD + short PT weekday (e.g., "07/20 Mon").
 *
 * The weekday is derived in America/Los_Angeles by anchoring the bare ISO
 * calendar date at noon UTC (T12:00:00Z). This mirrors formatDateDisplay and
 * avoids off-by-one weekday errors that occur when a YYYY-MM-DD string (e.g.
 * "2026-07-20") is parsed as a local/UTC-midnight instant on a non-PT runtime
 * near the DST or midnight boundary. Per AGENTS.md, all payroll date display
 * must be anchored to PT.
 *
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {string} e.g. "07/20 Mon"
 */
export function formatDateShortWithWeekday(dateStr) {
    const weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short',
    }).format(new Date(dateStr + 'T12:00:00Z'));
    const parts = String(dateStr).split('-');
    const month = parts[1] || '';
    const day = parts[2] || '';
    return `${month}/${day} ${weekday}`;
}
