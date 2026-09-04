/**
 * Time Validation Helpers
 * Ensures logical time entry and prevents negative hours
 */

import type { TimeEntry, TimeSegment } from '../app/lib/database';

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
    entry: Partial<TimeEntry> | null
): AnomalyResult {
    if (!time || step === 'complete') return { hasAnomaly: false };

    const timeMins = timeToMinutes(time);

    const standardWarningMessage = "This entry looks unusual. Please confirm that this is correct.";

    // 1. Weekend Check
    try {
        // Bug fix: previously used `new Date(workDate + 'T00:00:00').getDay()`
        // which parsed in runtime local TZ. Now UTC-anchored so the calendar
        // day is the calendar day regardless of server timezone.
        const [wy, wm, wd] = workDate.split('-').map(Number);
        if (wy && wm && wd) {
            const day = new Date(Date.UTC(wy, wm - 1, wd)).getUTCDay();
            if (day === 0 || day === 6) { // Sunday or Saturday
                return {
                    hasAnomaly: true,
                    message: standardWarningMessage
                };
            }
        }
    } catch { /* ignore date parse errors */ }

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

// ---------------------------------------------------------------------------
// Punch clock business rules (Phase 1 — Clock Agent)
// These are the single source of truth for "can I punch now?" checks.
// Enforces: 1 open segment max per employee per (PT) day.
// Re-uses the existing TimeSegment model (skipLunch + lunch* fields).
// All new ClockPunch / clockService code must call these before any write.
// ---------------------------------------------------------------------------

export interface PunchValidationResult {
  valid: boolean;
  message?: string;
}

/**
 * Returns true if the given entry has an incomplete (open) segment.
 * Mirrors database.hasOpenSegment but kept here for pure validation use.
 *
 * Falls back to legacy top-level fields (clockInManual / clockOutManual) when
 * the entry has no segments[] — handles docs written by the legacy TodayEntry
 * form which only writes top-level fields.
 */
function hasOpenSegmentLocal(entry: TimeEntry | null | undefined): boolean {
  if (!entry) return false;
  // Voided/archived entries are not active. Mirrors segmentOps.getActiveSegment
  // (the canonical implementation). Without this guard, the punchIn validator
  // and the UI both treat soft-voided test data as an open shift, which
  // makes cleanup scripts useless and forces a manual segments[] rewrite.
  if (entry.status === 'voided' || entry.status === 'archived') return false;
  if (entry.segments?.length) {
    const last = entry.segments[entry.segments.length - 1];
    if (last && last.complete !== true) return true;
  }
  const cur = entry.currentSegment;
  if (cur && cur.complete !== true) return true;
  if (entry.clockInManual && !entry.clockOutManual && !entry.complete) return true;
  return false;
}

/**
 * Can the employee perform a clock-in / start new segment right now?
 * Rule: No open segment allowed on the same logical PT workDate.
 */
export function validateCanPunchIn(entry: TimeEntry | null | undefined): PunchValidationResult {
  if (hasOpenSegmentLocal(entry)) {
    return {
      valid: false,
      message: 'You already have an open shift today. Clock out before starting a new one.',
    };
  }
  return { valid: true };
}

/**
 * Can the employee clock out (close the current open segment)?
 */
export function validateCanPunchOut(entry: TimeEntry | null | undefined): PunchValidationResult {
  if (!hasOpenSegmentLocal(entry)) {
    return {
      valid: false,
      message: 'No open shift to clock out of. Clock in first.',
    };
  }
  return { valid: true };
}

/**
 * Can the employee toggle lunch (out or in) on the current open segment?
 * Lunch is only valid on an open segment and follows the existing sequential rules
 * (lunchOut before lunchIn; optional skipLunch path).
 */
export function validateCanToggleLunch(entry: TimeEntry | null | undefined): PunchValidationResult {
  if (!hasOpenSegmentLocal(entry)) {
    return {
      valid: false,
      message: 'You must be clocked in to start or end a lunch break.',
    };
  }
  return { valid: true };
}

/**
 * Given an active segment, decide what the next lunch action label should be.
 * Pure helper for UI toggle button text.
 */
export function getLunchActionLabel(activeSegment: TimeSegment | null): string {
  if (!activeSegment) return 'LUNCH';
  if (!activeSegment.lunchOutManual && !activeSegment.lunchOutSystem) {
    return 'START LUNCH';
  }
  if (!activeSegment.lunchInManual && !activeSegment.lunchInSystem) {
    return 'END LUNCH';
  }
  return 'LUNCH DONE';
}

// ---------------------------------------------------------------------------
// Adjustment guardrails (2026-08): pure, jest-testable validators for the
// edit / correction flows (directEditSegmentField, directCloseShift,
// directEndLunch, resolveCorrectionRequest, admin Correct Entry).
// All chronology is CROSS-MIDNIGHT AWARE: times are normalized against the
// segment's clock-in anchor — a time earlier than clock-in is treated as
// next-day (+24h), so a valid 22:00 -> 06:00 overnight shift passes while a
// true inversion is rejected.
// ---------------------------------------------------------------------------

export interface SegmentChronologyShape {
  clockInManual?: string;
  lunchOutManual?: string;
  lunchInManual?: string;
  clockOutManual?: string;
  skipLunch?: boolean;
}

/** Parse HH:MM to minutes-since-midnight; null when absent/invalid. */
function parseHHMM(v: string | null | undefined): number | null {
  if (!v || typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Validate the chronological sequence of one shift segment.
 * Cross-midnight aware (unlike validateTimeEntry / validateTimeSequence,
 * which predate the wrap rule and false-reject overnight shifts).
 *
 * @param seg   the segment's manual punch fields (post-edit, pre-save)
 * @param opts.allowOpen  true for a still-open shift: clockOut may be absent
 *                        and an open lunch (lunchOut without lunchIn) is legal.
 * @returns human-readable error strings; empty array = valid.
 */
export function validateSegmentChronology(
  seg: SegmentChronologyShape,
  opts?: { allowOpen?: boolean },
): string[] {
  const errors: string[] = [];
  const inM = parseHHMM(seg.clockInManual);
  if (inM === null) {
    errors.push('Clock in is required');
    return errors; // no anchor — relative checks impossible
  }
  // Normalize against the clock-in anchor (S6 cross-midnight wrap).
  const wrap = (m: number): number => (m < inM ? m + 24 * 60 : m);

  const outM = parseHHMM(seg.clockOutManual);
  if (outM !== null) {
    if (wrap(outM) <= inM) errors.push('Clock out must be after clock in');
  } else if (!opts?.allowOpen) {
    errors.push('Clock out is required');
  }

  if (!seg.skipLunch) {
    const loM = parseHHMM(seg.lunchOutManual);
    const liM = parseHHMM(seg.lunchInManual);
    const hasLo = loM !== null;
    const hasLi = liM !== null;
    const openLunchOk = opts?.allowOpen === true && hasLo && !hasLi;
    if (hasLo !== hasLi && !openLunchOk) {
      errors.push('Both lunch times required or leave both empty');
    }
    if (hasLo && wrap(loM) <= inM) {
      errors.push('Lunch out must be after clock in');
    }
    if (hasLo && hasLi && wrap(liM!) <= wrap(loM)) {
      errors.push('Lunch in must be after lunch out');
    }
    if (outM !== null && hasLo && wrap(loM) >= wrap(outM)) {
      errors.push('Lunch out must be before clock out');
    }
    if (outM !== null && hasLi && wrap(liM!) > wrap(outM)) {
      errors.push('Lunch in must be before clock out');
    }
  }

  return errors;
}

const FUTURE_FIELD_LABELS: [keyof Pick<TimeSegment, 'clockInSystem' | 'lunchOutSystem' | 'lunchInSystem' | 'clockOutSystem'>, string][] = [
  ['clockInSystem', 'Clock in'],
  ['lunchOutSystem', 'Lunch out'],
  ['lunchInSystem', 'Lunch in'],
  ['clockOutSystem', 'Clock out'],
];

/**
 * Reject edits whose computed epoch timestamps land in the future.
 * Reads the *System epoch fields (the SSOT for instants) after the manual
 * HH:MM has been resolved to epochs via recomputeSegmentSystemTimestamps /
 * epochFromLocalWallTime — so this works for any anchor date + timezone.
 *
 * @returns an error string for the first future field, or null when clean.
 */
export function getFuturePunchError(
  seg: Pick<TimeSegment, 'clockInSystem' | 'lunchOutSystem' | 'lunchInSystem' | 'clockOutSystem'>,
  nowMs: number,
): string | null {
  for (const [key, label] of FUTURE_FIELD_LABELS) {
    const v = seg[key];
    if (typeof v === 'number' && v > nowMs) {
      return `${label} cannot be set to a time in the future.`;
    }
  }
  return null;
}

/**
 * Reject segment sets whose [clockInSystem, clockOutSystem] intervals overlap
 * (double-counted payroll). Only complete segments with both epochs are
 * compared; open segments have no end interval and are skipped.
 *
 * @returns an error string on the first overlap found, or null when clean.
 */
export function getSegmentOverlapError(
  segments: Array<Pick<TimeSegment, 'clockInSystem' | 'clockOutSystem'>>,
): string | null {
  const intervals: { start: number; end: number }[] = [];
  for (const s of segments) {
    if (typeof s.clockInSystem === 'number' && typeof s.clockOutSystem === 'number') {
      intervals.push({ start: s.clockInSystem, end: s.clockOutSystem });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start < intervals[i - 1].end) {
      return 'This adjustment would overlap with another shift on the same day. Adjust the times so shifts do not overlap.';
    }
  }
  return null;
}