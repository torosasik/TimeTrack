/**
 * Shift & lunch guardrail decision logic (pure, jest-testable, no firebase).
 *
 * Encodes the server-side auto-guardrail thresholds shared by the scheduled
 * Cloud Function (`functions/src/autoGuardrails.ts`) and the client-side
 * warning surface:
 *
 *  - On-site auto-close: close the active shift at 10:00 PM (22:00) in the
 *    employee's local timezone.
 *  - Remote auto-close: close the active shift at the 12-hour mark since
 *    clock-in.
 *  - Lunch auto-end: if the employee has been "On Lunch" for 60 minutes
 *    without ending lunch, auto-record the lunch-in at the 60-minute mark.
 *
 * This module uses the shared Intl-based timezone helpers (works in both the
 * browser and Node 20) so the Cloud Function and unit tests agree on the exact
 * boundary instants. Only the decision is computed here — the actual Firestore
 * writes, audit logging, and flagging live in the callers.
 */

import { localDateOf, localTimeHHMM } from './midnightSplit';
import { epochFromLocalWallTime } from './timeCalculations';
import { DEFAULT_GUARDRAIL_LIMITS, type GuardrailLimits } from './guardrailLimits';

// Defaults — the live values come from systemSettings/global via the
// `limits` parameter (Settings → Automated Actions). These constants remain
// as the pre-settings fallback.
export const ON_SITE_CLOSE_HHMM = DEFAULT_GUARDRAIL_LIMITS.onsiteLatestAllowedTime;
export const ON_SITE_RECORDED_HHMM = DEFAULT_GUARDRAIL_LIMITS.onsiteRecordedTime;
export const REMOTE_MAX_SHIFT_MS = DEFAULT_GUARDRAIL_LIMITS.remoteMaxWorkHours * 60 * 60 * 1000;
export const LUNCH_AUTO_END_MS = DEFAULT_GUARDRAIL_LIMITS.onsiteLunchMaxMinutes * 60 * 1000;
export const LUNCH_RECORDED_MS = DEFAULT_GUARDRAIL_LIMITS.onsiteLunchRecordedMinutes * 60 * 1000;

export type GuardrailReason = 'on_site_10pm' | 'remote_12h' | 'lunch_1h';

/** Minimal shape of an open shift the guardrails operate on. */
export interface OpenShiftState {
  clockInSystem?: number;
  lunchOutSystem?: number;
  lunchInSystem?: number;
  skipLunch?: boolean;
  clockOutSystem?: number;
  complete?: boolean;
}

export interface GuardrailDecision {
  reason: GuardrailReason | null;
  /** The TRIGGER instant (epoch ms) at which the guardrail fires, or null. */
  actionAtMs: number | null;
  /**
   * The RECORDED instant (epoch ms) stamped as clockOut / lunchIn. Differs
   * from actionAtMs for on-site shifts (cutoff 22:00 records 17:00) and
   * lunches (max 120min records 60min) per Settings → Automated Actions.
   */
  recordedAtMs: number | null;
  /** Local HH:MM wall-clock string for the RECORDED instant (or null). */
  actionManual: string | null;
  /** Elapsed ms since the shift's clock-in (for logging / audit context). */
  elapsedMs: number;
}

const DAY = 24 * 60 * 60 * 1000;

function emptyDecision(elapsedMs: number): GuardrailDecision {
  return { reason: null, actionAtMs: null, recordedAtMs: null, actionManual: null, elapsedMs };
}

/** Earliest local latestAllowedTime that is at-or-after the shift's clock-in. */
function onSiteCloseInstant(clockInSystem: number, timezone: string, latestHHMM: string): number {
  const clockInDate = localDateOf(clockInSystem, timezone);
  const todayClose = epochFromLocalWallTime(latestHHMM, clockInDate, timezone);
  if (typeof todayClose === 'number' && todayClose >= clockInSystem) return todayClose;
  // Clocked in after the cutoff — close at the next calendar day's cutoff.
  const nextDate = localDateOf(clockInSystem + DAY, timezone);
  const nextClose = epochFromLocalWallTime(latestHHMM, nextDate, timezone);
  return typeof nextClose === 'number' ? nextClose : clockInSystem + DAY;
}

/**
 * The RECORDED clock-out instant for an on-site auto-close: the configured
 * onsiteRecordedTime on the clock-in's local date. Guard: when that instant
 * would precede the clock-in (e.g. night shift clocked in at 23:00 with a
 * 17:00 recorded time) or exceed the trigger, fall back to the trigger so the
 * recorded span is always positive and never later than the cutoff.
 */
function onSiteRecordedInstant(
  clockInSystem: number,
  triggerAtMs: number,
  timezone: string,
  recordedHHMM: string,
): number {
  const clockInDate = localDateOf(clockInSystem, timezone);
  const recorded = epochFromLocalWallTime(recordedHHMM, clockInDate, timezone);
  if (typeof recorded === 'number' && recorded > clockInSystem && recorded <= triggerAtMs) {
    return recorded;
  }
  return triggerAtMs;
}

/**
 * Decide whether an open shift must be auto-closed at `nowMs`.
 *
 * - `Remote` work model → close at clock-in + 12 hours.
 * - Anything else (including `On-site`) → close at the earliest local 22:00
 *   that is at-or-after clock-in.
 */
export function decideShiftAutoClose(input: {
  nowMs: number;
  workModel: string;
  shift: OpenShiftState;
  timezone?: string;
  /** Active Settings → Automated Actions limits (defaults when omitted). */
  limits?: GuardrailLimits;
}): GuardrailDecision {
  const { nowMs, workModel, shift, timezone } = input;
  const L = input.limits ?? DEFAULT_GUARDRAIL_LIMITS;
  const clockInSystem = typeof shift.clockInSystem === 'number' ? shift.clockInSystem : undefined;

  if (shift.complete || clockInSystem === undefined) {
    return emptyDecision(0);
  }

  const elapsedMs = nowMs - clockInSystem;
  const tz = timezone || 'America/Los_Angeles';

  if (String(workModel).toLowerCase() === 'remote') {
    const closeAt = clockInSystem + L.remoteMaxWorkHours * 60 * 60 * 1000;
    if (nowMs >= closeAt) {
      // Remote: trigger == recorded instant.
      return { reason: 'remote_12h', actionAtMs: closeAt, recordedAtMs: closeAt, actionManual: localTimeHHMM(closeAt, tz), elapsedMs };
    }
    return emptyDecision(elapsedMs);
  }

  const closeAt = onSiteCloseInstant(clockInSystem, tz, L.onsiteLatestAllowedTime);
  if (nowMs >= closeAt) {
    const recordedAt = onSiteRecordedInstant(clockInSystem, closeAt, tz, L.onsiteRecordedTime);
    return { reason: 'on_site_10pm', actionAtMs: closeAt, recordedAtMs: recordedAt, actionManual: localTimeHHMM(recordedAt, tz), elapsedMs };
  }
  return emptyDecision(elapsedMs);
}

/**
 * Decide whether an in-progress lunch must be auto-ended at `nowMs`.
 * Only applies when the employee is "On Lunch" (lunchOut set, lunchIn not set,
 * lunch not skipped) and 60 minutes have elapsed since lunch-out.
 */
export function decideLunchAutoEnd(input: {
  nowMs: number;
  shift: OpenShiftState;
  /** Active Settings → Automated Actions limits (defaults when omitted). */
  limits?: GuardrailLimits;
}): GuardrailDecision {
  const { nowMs, shift } = input;
  const L = input.limits ?? DEFAULT_GUARDRAIL_LIMITS;
  if (shift.complete || shift.skipLunch) return emptyDecision(0);

  const lunchOut = typeof shift.lunchOutSystem === 'number' ? shift.lunchOutSystem : undefined;
  const lunchIn = typeof shift.lunchInSystem === 'number' ? shift.lunchInSystem : undefined;
  if (lunchOut === undefined || lunchIn !== undefined) return emptyDecision(0);

  // Trigger at the configured max; RECORD lunchIn at lunchOut + recorded
  // minutes (e.g. fires at 120min, records a 60-minute lunch).
  const endAt = lunchOut + L.onsiteLunchMaxMinutes * 60 * 1000;
  if (nowMs >= endAt) {
    const recordedAt = lunchOut + L.onsiteLunchRecordedMinutes * 60 * 1000;
    return { reason: 'lunch_1h', actionAtMs: endAt, recordedAtMs: recordedAt, actionManual: null, elapsedMs: nowMs - lunchOut };
  }
  return emptyDecision(nowMs - lunchOut);
}

// ---------------------------------------------------------------------------
// Employee warning detection (non-blocking)
// ---------------------------------------------------------------------------

/** Minimal entry shape needed to detect a prior guardrail action. */
export interface GuardrailEntryLike {
  status?: string;
  autoClosed?: boolean;
  autoEndedLunch?: boolean;
  segments?: Array<{ autoClosed?: boolean; autoEndedLunch?: boolean; splitFromMidnight?: boolean; flagged?: boolean }>;
  currentSegment?: { autoClosed?: boolean; autoEndedLunch?: boolean; splitFromMidnight?: boolean; flagged?: boolean } | null;
}

/**
 * True only for a REAL guardrail close. Routine local-midnight splits stamp
 * autoClosed: true on every cross-midnight Day-1 part (midnightSplit.ts) —
 * those are excluded unless the segment is also flagged (the cron and the
 * runaway-repair writer set flagged on segments they close).
 */
function isGuardrailClose(s: { autoClosed?: boolean; splitFromMidnight?: boolean; flagged?: boolean } | undefined): boolean {
  return s?.autoClosed === true && (s.splitFromMidnight !== true || s.flagged === true);
}

export const GUARDRAIL_WARNING_TEXT =
  'Notice: Your previous shift/lunch was automatically updated by system guardrails. Please review your hours.';

/**
 * Build the warning text, appending the ACTIVE configured limits when the
 * caller passes them (ClockPunch fetches systemSettings/global) so the banner
 * reflects the rules that actually fired — not stale hardcoded numbers.
 */
export function guardrailWarningText(limits?: GuardrailLimits | null): string {
  if (!limits) return GUARDRAIL_WARNING_TEXT;
  return (
    GUARDRAIL_WARNING_TEXT +
    ` Active rules: on-site shifts auto-close at ${limits.onsiteLatestAllowedTime}` +
    ` (recorded ${limits.onsiteRecordedTime}); lunches auto-end after` +
    ` ${limits.onsiteLunchMaxMinutes} min (recorded ${limits.onsiteLunchRecordedMinutes} min);` +
    ` remote shifts auto-close after ${limits.remoteMaxWorkHours}h.`
  );
}

/**
 * True when any non-voided/archived/corrected entry carries a guardrail marker
 * (`autoClosed` or `autoEndedLunch`) at the entry, current-segment, or
 * persisted-segment level. Used to show a WARNING-ONLY banner on the employee
 * dashboard — it never blocks clocking in for a new day.
 */
export function detectGuardrailWarning(
  entries: GuardrailEntryLike[],
  limits?: GuardrailLimits | null,
): {
  hasWarning: boolean;
  reason: string;
} {
  for (const e of entries) {
    if (e.status === 'voided' || e.status === 'archived' || e.status === 'corrected') continue;
    const autoClosed =
      e.autoClosed === true ||
      isGuardrailClose(e.currentSegment ?? undefined) ||
      (e.segments ?? []).some((s) => isGuardrailClose(s));
    const autoEndedLunch =
      e.autoEndedLunch === true ||
      e.currentSegment?.autoEndedLunch === true ||
      (e.segments ?? []).some((s) => s.autoEndedLunch === true);
    if (autoClosed || autoEndedLunch) {
      return { hasWarning: true, reason: guardrailWarningText(limits) };
    }
  }
  return { hasWarning: false, reason: '' };
}
