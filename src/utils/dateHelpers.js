/**
 * Date Helper Functions
 */

/**
 * Get yesterday's date in YYYY-MM-DD format
 * @returns {string} Yesterday's date
 */
export function getYesterdayDate() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return formatDateYYYYMMDD(yesterday);
}

/**
 * Get today's date in YYYY-MM-DD format
 * @returns {string} Today's date
 */
export function getTodayDate() {
    return formatDateYYYYMMDD(new Date());
}

/**
 * Format a date object to YYYY-MM-DD string
 * @param {Date} date - Date object
 * @returns {string} Formatted date
 */
export function formatDateYYYYMMDD(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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
 * Parse YYYY-MM-DD string to Date object
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {Date} Date object
 */
export function parseDate(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
}

/**
 * Format date to display format (e.g., "Monday, Dec 15, 2025")
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {string} Formatted date string
 */
export function formatDateDisplay(dateStr) {
    const date = parseDate(dateStr);
    const options = { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}
