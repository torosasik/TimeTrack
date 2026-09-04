/**
 * In-memory virtual closure of open shifts (Analytics projection).
 *
 * Pure, jest-testable, no firebase dependency (same rationale as
 * app/lib/segmentOps.ts). Used by the Analytics pipeline
 * (services/attributedEntries.ts) to project still-open shifts forward to
 * the current moment so their accumulated hours count toward totals and the
 * Regular/OT/DT split.
 *
 * STRICT RULE: this is a read-side projection. It never writes to Firestore
 * and never mutates its inputs — projected docs are copies tagged
 * `projectedOpen` / `projectedClosed` so the UI can badge them.
 */

import type { DocumentData } from 'firebase/firestore';
import { computeSegmentWorkMinutes } from '../app/lib/segmentOps';
import type { TimeSegment } from '../app/lib/database';
import { DEFAULT_GUARDRAIL_LIMITS } from './guardrailLimits';

/**
 * In-progress lunch projection policy (mirrors the autoGuardrails cron):
 *
 * - Elapsed < `lunchMaxMinutes`  → the cron has NOT fired; the lunch is
 *   legitimately still open. Deduct the ACTUAL elapsed time (lunchOut → now).
 * - Elapsed >= `lunchMaxMinutes` → the cron would have (or will) auto-end the
 *   lunch, stamping `lunchIn = lunchOut + lunchRecordedMinutes`. Mirror that:
 *   cap the deduction to `lunchRecordedMinutes`.
 *
 * Without the over-threshold cap, a forgotten lunch-start deducts every
 * minute from lunch start to `now` — potentially hours — producing wildly
 * inconsistent projections between employees who clocked in minutes apart
 * (e.g. 8:05 AM vs 8:19 AM showing 8.23h vs 6.13h).
 */
export interface OpenShiftProjectionOptions {
  /** Settings → Automated Actions: max minutes an on-site lunch may stay open. */
  lunchMaxMinutes?: number;
  /** Settings → Automated Actions: lunch duration recorded when the max is hit. */
  lunchRecordedMinutes?: number;
}

/** Structural type for Firestore Timestamp-like values (avoids `any` casts). */
interface TimestampLike {
  toMillis(): number;
  toDate(): Date;
}

/**
 * Normalize a raw Firestore time field (epoch millis | Timestamp | Date) to
 * epoch millis. Raw docs dual-write `clockInSystem` (millis) AND
 * `clockInSystemTime` (Timestamp); legacy rows may carry only the Timestamp.
 */
export function toMillis(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object' && typeof (value as TimestampLike).toMillis === 'function') {
    return (value as TimestampLike).toMillis();
  }
  return undefined;
}

/** Prefer the Timestamp dual-write (`*SystemTime`) when present, else millis. */
function sysMillis(obj: DocumentData, base: string): number | undefined {
  return toMillis(obj[`${base}Time`]) ?? toMillis(obj[base]);
}

/**
 * Virtually close one open segment at `nowMs` (copies; input untouched).
 * An in-progress lunch is deducted from the projected span per the
 * threshold-aware policy documented on OpenShiftProjectionOptions:
 * under the cron's max threshold the ACTUAL elapsed lunch is deducted;
 * at/over the threshold the deduction is capped to the recorded minutes
 * (mirroring what the cron stamps when it auto-ends the lunch).
 * Returns null when the segment has no usable clock-in anchor (or `nowMs`
 * precedes it — clock skew).
 */
function virtuallyCloseSegment(
  seg: DocumentData,
  nowMs: number,
  lunchMaxMs: number,
  lunchRecordedMs: number,
): DocumentData | null {
  const inMs = sysMillis(seg, 'clockInSystem');
  if (inMs === undefined || nowMs < inMs) return null; // no anchor / clock skew
  const skipLunch = seg.skipLunch === true || seg.lunchSkipped === true;
  const loMs = sysMillis(seg, 'lunchOutSystem');
  const liMs = sysMillis(seg, 'lunchInSystem');
  // In-progress lunch (started, never ended): decide the projected lunch-in.
  // - elapsed < max  → still legitimately open: end at nowMs (actual elapsed).
  // - elapsed >= max → cron would auto-end with recorded minutes: cap.
  let projectedLiMs = liMs;
  if (liMs === undefined && loMs !== undefined) {
    const elapsedMs = nowMs - loMs;
    projectedLiMs = elapsedMs < lunchMaxMs ? nowMs : loMs + lunchRecordedMs;
  }
  const closed: DocumentData = {
    ...seg,
    clockInSystem: inMs,
    clockOutSystem: nowMs,
    skipLunch,
    // In-progress lunch ends at the virtual close (threshold-aware); a
    // completed lunch is kept as-is.
    lunchOutSystem: skipLunch ? undefined : loMs,
    lunchInSystem: skipLunch ? undefined : projectedLiMs,
    complete: true,
    // Display-layer markers (in-memory only — nothing here is persisted).
    projectedClosed: true,
    projectedNow: nowMs,
  };
  // Feed the projection through the canonical segment-minutes SSOT: with no
  // manual clock-out, resolution falls to the system span (inMs → nowMs)
  // minus the (possibly just-closed) lunch.
  closed.workMinutes = computeSegmentWorkMinutes(closed as TimeSegment);
  return closed;
}

/**
 * Project every still-open shift forward to `nowMs`, in memory only.
 *
 * Two open shapes are recognized (mirrors the cron's getOpenSegment):
 *  1. An open segment in `segments[]` (`complete !== true`, no clock-out).
 *  2. The legacy top-level-only open shift (top-level clockIn set, no
 *     clockOut, `dayComplete !== true`) — materialized as a synthesized
 *     segment so its hours count. Guarded by mapEntry's S1 same-shift rule:
 *     when the top-level clock-in matches the last persisted segment's
 *     clock-in, the root fields merely mirror that (closed) shift and no new
 *     segment is synthesized.
 *
 * Projected docs are copies tagged `projectedOpen: true` (+ `projectedNow`)
 * with totals rebuilt from the canonical segment-minutes SSOT and the stored
 * daily OT buckets cleared so the overtime engine recomputes Regular/OT/DT
 * from the projected totals (calculateWeeklyOvertimeAdjustments skips daily
 * recalc when regularMinutes is present). Voided/archived docs are never
 * projected. Non-projected docs are returned by reference (unchanged).
 *
 * Attribution note: an open shift stays attributed to its punch-in date (its
 * doc's workDate) even when `now` has crossed midnight — the same attribution
 * Team/History give a live open shift today.
 */
export function projectOpenShiftsAt(
  entries: DocumentData[],
  nowMs: number,
  options: OpenShiftProjectionOptions = {},
): DocumentData[] {
  const lunchMaxMs =
    (options.lunchMaxMinutes ?? DEFAULT_GUARDRAIL_LIMITS.onsiteLunchMaxMinutes) * 60 * 1000;
  const lunchRecordedMs =
    (options.lunchRecordedMinutes ?? DEFAULT_GUARDRAIL_LIMITS.onsiteLunchRecordedMinutes) * 60 * 1000;
  return entries.map(e => {
    if (e.status === 'voided' || e.status === 'archived') return e;

    const segs: DocumentData[] = Array.isArray(e.segments) ? e.segments : [];
    const openIdx = segs.findIndex(s => {
      if (s?.complete === true) return false;
      const hasOut = !!s?.clockOutManual || sysMillis(s, 'clockOutSystem') !== undefined;
      return !hasOut;
    });

    let newSegs: DocumentData[];
    if (openIdx >= 0) {
      const closed = virtuallyCloseSegment(segs[openIdx], nowMs, lunchMaxMs, lunchRecordedMs);
      if (!closed) return e; // no clock-in anchor — leave unprojected
      newSegs = segs.slice();
      newSegs[openIdx] = closed;
    } else if (e.clockInManual && !e.clockOutManual && e.dayComplete !== true) {
      // Legacy top-level-only open shift (open shift lives only in the doc's
      // root fields) — materialize it as a segment so it accumulates.
      const lastSeg = segs.length ? segs[segs.length - 1] : null;
      if (lastSeg && lastSeg.clockInManual === e.clockInManual) {
        // S1 dual-write divergence guard: the root fields mirror the last
        // persisted (closed) shift — not a new open shift.
        return e;
      }
      const closed = virtuallyCloseSegment({
        id: `${String(e.id ?? 'entry')}_virtual_now`,
        clockInManual: e.clockInManual,
        clockInSystem: sysMillis(e, 'clockInSystem'),
        lunchOutManual: e.lunchOutManual,
        lunchOutSystem: sysMillis(e, 'lunchOutSystem'),
        lunchInManual: e.lunchInManual,
        lunchInSystem: sysMillis(e, 'lunchInSystem'),
        skipLunch: e.skipLunch === true || e.lunchSkipped === true,
        complete: false,
      }, nowMs, lunchMaxMs, lunchRecordedMs);
      if (!closed) return e;
      newSegs = [...segs, closed];
    } else {
      return e; // fully closed day (or no open shift) — untouched
    }

    const totalWorkMinutes = newSegs.reduce((sum, s) => sum + (Number(s.workMinutes) || 0), 0);
    return {
      ...e,
      segments: newSegs,
      totalWorkMinutes,
      totalHours: totalWorkMinutes / 60,
      // Clear persisted daily OT buckets so the OT engine recomputes
      // Regular/OT/DT from the projected totals.
      regularMinutes: undefined,
      otMinutes: undefined,
      doubleTimeMinutes: undefined,
      // Display-layer markers (in-memory only — never persisted).
      projectedOpen: true,
      projectedNow: nowMs,
    };
  });
}
