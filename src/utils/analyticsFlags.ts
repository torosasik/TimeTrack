/**
 * Analytics Flags view — pure flag computation for the Daily Breakdown table.
 *
 * SSOT rule (task requirement): every flag is computed IN MEMORY from the
 * normalized, exploded entries already returned by the shared
 * Payroll/Analytics pipeline (services/attributedEntries.ts). No data loaders
 * from AuditViewer / PatternMetrics / TeamDashboard are imported or triggered.
 *
 * Two scopes:
 *  - Shift-level flags (per segment): auto_closed_shift, auto_ended_lunch,
 *    short_lunch, long_lunch, anomaly_detected + audit flags
 *    (batch_submission, after_hours_submission). Rendered on
 *    child shift rows AND aggregated into the parent day row.
 *  - Day-level flags (per day row ONLY): very_long_day, very_short_day,
 *    missing_lunch. Never rendered on child shift rows.
 *
 * Thresholds mirror the canonical calculateFlags (app/lib/database.ts);
 * Timestamp-like raw fields are normalized via the shared toMillis
 * (openShiftProjection.ts).
 */

import type { DocumentData } from 'firebase/firestore';
import { toMillis } from './openShiftProjection';
import { PT_ZONE } from './timeView';

// Thresholds — same values as calculateFlags / AuditViewer.
const SHORT_LUNCH_MIN = 20;
const LONG_LUNCH_MIN = 90;
const VERY_LONG_DAY_H = 11;
const VERY_SHORT_DAY_H = 4;
const BATCH_SUBMISSION_SPAN_MIN = 5;

/** Human-readable chip labels for every flag id. */
export const FLAG_LABELS: Record<string, string> = {
  auto_closed_shift: 'Auto-Closed Shift',
  auto_ended_lunch: 'Auto-Ended Lunch',
  short_lunch: 'Short Lunch',
  long_lunch: 'Long Lunch',
  very_long_day: 'Very Long Day',
  very_short_day: 'Very Short Day',
  anomaly_detected: 'Anomaly Detected',
  batch_submission: 'Batch Submission',
  after_hours_submission: 'After Hours',
  missing_lunch: 'Missing Lunch',
};

/** Chip color family per flag (guardrail = red, pattern = amber, audit = purple). */
export const FLAG_SEVERITY: Record<string, 'red' | 'amber' | 'purple'> = {
  auto_closed_shift: 'red',
  auto_ended_lunch: 'red',
  anomaly_detected: 'red',
  missing_lunch: 'red',
  batch_submission: 'purple',
  after_hours_submission: 'purple',
  short_lunch: 'amber',
  long_lunch: 'amber',
  very_long_day: 'amber',
  very_short_day: 'amber',
};

/** Shift-level flags — the only set allowed on child shift rows. */
const SHIFT_LEVEL_FLAGS = new Set([
  'auto_closed_shift',
  'auto_ended_lunch',
  'short_lunch',
  'long_lunch',
  'anomaly_detected',
  'batch_submission',
  'after_hours_submission',
]);

export function isShiftLevelFlag(flag: string): boolean {
  return SHIFT_LEVEL_FLAGS.has(flag);
}

// ---------------------------------------------------------------------------
// Shift-level computation
// ---------------------------------------------------------------------------

export interface SegmentFlagContext {
  /** Doc-level markers mirror the LAST segment (dual-write convention). */
  isLastSegment: boolean;
  /** Doc-level autoClosed (applies to the last/active segment). */
  docAutoClosed?: boolean;
  /** Doc-level autoEndedLunch (applies to the last/active segment). */
  docAutoEndedLunch?: boolean;
  /** Doc-level anomaly_flag (employee submitted past a soft warning). */
  docAnomaly?: boolean;
  /** Doc-level completedAt (epoch ms | Timestamp) — for after-hours audit. */
  completedAt?: unknown;
  /**
   * Whether the employee works under the 'On-site' work model. REQUIRED for
   * the after_hours_submission flag: that check enforces an admin-defined
   * company-hours window (PT), which applies to on-site staff only — remote
   * workers keep flexible schedules, so the flag must never fire for them.
   * When omitted (undefined), the after-hours check is skipped.
   */
  isOnSite?: boolean;
}

function minutesOf(time: unknown): number {
  if (typeof time !== 'string' || !time) return NaN;
  const [h, m] = time.split(':').map(Number);
  return Number.isNaN(h) || Number.isNaN(m) ? NaN : h * 60 + m;
}

/** Lunch duration (minutes) for one segment: system span preferred, manual
 * single-day-wrap fallback. null when no lunch was recorded. */
function segmentLunchMinutes(seg: DocumentData): number | null {
  if (seg.skipLunch === true || seg.lunchSkipped === true) return null;
  const loMs = toMillis(seg.lunchOutSystemTime) ?? toMillis(seg.lunchOutSystem);
  const liMs = toMillis(seg.lunchInSystemTime) ?? toMillis(seg.lunchInSystem);
  if (loMs !== undefined && liMs !== undefined && liMs >= loMs) {
    return Math.round((liMs - loMs) / 60000);
  }
  const loM = minutesOf(seg.lunchOutManual);
  const liM = minutesOf(seg.lunchInManual);
  if (Number.isNaN(loM) || Number.isNaN(liM)) return null;
  const diff = liM - loM;
  return diff < 0 ? diff + 1440 : diff;
}

/* --- After-hours zone math --------------------------------------------------
 * The after-hours rule compares the completion instant against a PT wall-clock
 * window — it is an admin-defined company-hours threshold, and PT is the
 * canonical admin zone (AGENTS.md). */

function hourAndMinutesInZone(millis: number, zone: string): { h: number; m: number } | null {
  if (typeof millis !== 'number' || !Number.isFinite(millis)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(millis));
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
  return { h: h === 24 ? 0 : h, m };
}

/**
 * Compute the SHIFT-LEVEL flags for one segment (or a segment-less legacy doc
 * whose root fields double as the single shift).
 */
export function getSegmentFlags(seg: DocumentData, ctx: SegmentFlagContext): string[] {
  const flags: string[] = [];
  // In-memory now-projections mark still-open shifts complete with a virtual
  // clockOut = now. They are estimates, NOT real completions: lunch-pattern
  // and batch-span flags must not fire on them (an ongoing lunch clamped to
  // "now" is not a 90-minute lunch; a 3-minute-old live shift is not a batch
  // submission).
  const isProjection = seg.projectedClosed === true;

  // Guardrail markers. Routine midnight-split parts stamp autoClosed without
  // being guardrail closes — same exemption as the canonical calculateFlags.
  const segAutoClosed = seg.autoClosed === true && (seg.splitFromMidnight !== true || seg.flagged === true);
  const autoClosed = segAutoClosed || (ctx.isLastSegment && ctx.docAutoClosed === true);
  if (autoClosed) flags.push('auto_closed_shift');

  const autoEndedLunch = seg.autoEndedLunch === true || (ctx.isLastSegment && ctx.docAutoEndedLunch === true);
  if (autoEndedLunch) flags.push('auto_ended_lunch');

  // Pattern flags — only for genuinely completed shifts (mirrors
  // calculateFlags' gate on entry.complete), never on projected live shifts.
  if (seg.complete === true && !isProjection) {
    const lunch = segmentLunchMinutes(seg);
    if (lunch !== null) {
      if (lunch < SHORT_LUNCH_MIN) flags.push('short_lunch');
      else if (lunch > LONG_LUNCH_MIN) flags.push('long_lunch');
    }
  }

  if (ctx.isLastSegment && ctx.docAnomaly === true) flags.push('anomaly_detected');

  // Audit flags — system-timestamp heuristics.
  const inMs = toMillis(seg.clockInSystemTime) ?? toMillis(seg.clockInSystem);
  const outMs = toMillis(seg.clockOutSystemTime) ?? toMillis(seg.clockOutSystem);
  // Batch submission (whole shift punched within 5 minutes) — a span, so
  // zone-invariant; suppressed for projected live shifts.
  if (!isProjection && inMs !== undefined && outMs !== undefined) {
    const spanMin = Math.abs(outMs - inMs) / 60000;
    if (spanMin < BATCH_SUBMISSION_SPAN_MIN) flags.push('batch_submission');
  }
  // After-hours completion — admin-defined company-hours threshold in PT.
  // On-site workers only: remote employees keep flexible schedules, so the
  // check is skipped entirely when the work model is not 'On-site'.
  if (ctx.isOnSite === true && ctx.isLastSegment && ctx.completedAt != null) {
    const completedMs = toMillis(ctx.completedAt);
    if (completedMs !== undefined) {
      const hm = hourAndMinutesInZone(completedMs, PT_ZONE);
      if (hm && (hm.h >= 18 || hm.h < 6)) flags.push('after_hours_submission');
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Day-level computation (parent rows ONLY)
// ---------------------------------------------------------------------------

/**
 * Compute the DAY-LEVEL flags for one day row. Never render these on child
 * shift rows. Gated on the day being complete (raw docs carry `dayComplete`,
 * synthetic exploded parts carry `complete`) or projected-open, mirroring the
 * canonical calculateFlags gate.
 */
export function getDayLevelFlags(day: DocumentData): string[] {
  const flags: string[] = [];
  const complete = day.synthetic === true
    ? day.complete === true
    : day.dayComplete === true || day.complete === true;
  if (!complete && day.projectedOpen !== true) return flags;

  const totalHours = Number(day.totalHours) || (Number(day.totalWorkMinutes) || 0) / 60;
  if (totalHours > VERY_LONG_DAY_H) flags.push('very_long_day');
  else if (totalHours > 0 && totalHours < VERY_SHORT_DAY_H) flags.push('very_short_day');
  return flags;
}

/**
 * The combined parent-row flag set: all child shift-level flags + day-level
 * flags (+ missing_lunch, decided at render where the work model is known).
 */
export function getParentRowFlags(day: DocumentData, childFlags: string[][], extraDayFlags: string[] = []): string[] {
  const all = [...getDayLevelFlags(day), ...extraDayFlags, ...childFlags.flat()];
  return [...new Set(all)];
}
