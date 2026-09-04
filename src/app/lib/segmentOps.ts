/**
 * Punch segment operations — pure functions, no firebase dependency.
 *
 * Owns the TimeSegment mutation logic for the Clock Agent. Imported by
 * clockService.ts (which does the actual Firestore writes) and by jest tests
 * (which can import these without needing a firebase emulator).
 *
 * Why this file exists: the previous version of these helpers lived in
 * database.ts alongside the firebase-firestore imports. That made them
 * impossible to unit-test in jest (firebase's web SDK throws on import in
 * node without an emulator). Splitting them out keeps the pure logic pure.
 */

import type { TimeEntry, TimeSegment } from './database';
import { epochFromLocalWallTime } from '../../utils/timeCalculations';

/**
 * Strip undefined values from an object. Firestore rejects any field with
 * value `undefined` (it errors with "Unsupported field value: undefined"),
 * so we strip them before passing to `setDoc` / `updateDoc`. This is a known
 * foot-gun: callers often spread `...entry` and pick up optional fields.
 */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/** Create a fresh open segment for a new punch-in. */
export function createInitialSegment(clockInManual: string, clockInSystem: number, taskId?: string): TimeSegment {
  const seg: TimeSegment = {
    id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    clockInManual,
    clockInSystem,
    complete: false,
  };
  if (taskId) seg.taskId = taskId; // omit if not set, never write undefined
  return seg;
}

function timeToMinutes(time: string | undefined | null): number {
  if (!time) return NaN;
  const [h, m] = String(time).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 60 + m;
}

/** Lunch duration (minutes) from system lunch timestamps, else 0. */
function lunchMinutesFromSystem(seg: TimeSegment): number {
  const lo = typeof seg.lunchOutSystem === 'number' ? seg.lunchOutSystem : undefined;
  const li = typeof seg.lunchInSystem === 'number' ? seg.lunchInSystem : undefined;
  if (lo === undefined || li === undefined || li < lo) return 0;
  return Math.max(0, Math.round((li - lo) / (1000 * 60)));
}

/** Lunch duration (minutes) from manual lunch strings, single-day wrap aware. */
function lunchMinutesFromManual(seg: TimeSegment, inM: number): number {
  if (!seg.lunchOutManual || !seg.lunchInManual) return 0;
  const lo = timeToMinutes(seg.lunchOutManual);
  const li = timeToMinutes(seg.lunchInManual);
  if (Number.isNaN(lo) || Number.isNaN(li) || Number.isNaN(inM)) return 0;
  const effLo = lo < inM ? lo + 24 * 60 : lo;
  const effLi = li < inM ? li + 24 * 60 : li;
  return Math.max(0, effLi - effLo);
}

/**
 * Compute worked minutes for a (closed) segment — the single canonical
 * segment-minutes source of truth (SSOT) for both write-side recalculation and
 * read-side reports.
 *
 * Resolution order (never measures raw un-updated system timestamps alone):
 * 1. Stored `workMinutes` when it AGREES with the manual signal (within 1 min).
 *    This absorbs the second-truncation at split boundaries (a 23:59:59 close
 *    stored as '23:59') and preserves the accurate system-derived value for
 *    fresh closes / split parts.
 * 2. Manual-derived minutes (clockInManual→clockOutManual, single-day
 *    cross-midnight wrap aware, manual lunch) when stored is ABSENT or has
 *    DIVERGED. A manual edit updates ONLY the *Manual strings — the stored
 *    workMinutes and the system timestamps go stale — so a divergent stored
 *    value means "this segment was edited; trust the manual times."
 * 3. System-timestamp span (clockInSystem→clockOutSystem) when the manual punch
 *    times are absent (legacy/manual-less rows).
 * 4. Stored value as a last resort.
 *
 * Used by closeActiveSegment (on close), buildConsistentClosePatch, the
 * direct-edit write paths, mapEntry's day-total, and report-time
 * normalization — so an edit propagates identically to every view.
 *
 * @param seg                  the segment (complete or about to be closed)
 * @param clockOutSystemOverride  when closing, the fresh clock-out epoch-ms not yet on seg
 */
export function computeSegmentWorkMinutes(
  seg: TimeSegment,
  clockOutSystemOverride?: number,
): number {
  const skipLunch = seg.skipLunch === true;
  const inManual = seg.clockInManual;
  const outManual = seg.clockOutManual;
  const inSys = typeof seg.clockInSystem === 'number' ? seg.clockInSystem : undefined;
  const outSys = typeof clockOutSystemOverride === 'number'
    ? clockOutSystemOverride
    : (typeof seg.clockOutSystem === 'number' ? seg.clockOutSystem : undefined);

  // Manual-derived minutes (the employee/admin-intended span). After a manual
  // edit only the *Manual strings change, so this is the signal that reveals
  // whether the stored workMinutes is still valid.
  let manualMins: number | undefined;
  if (inManual && outManual) {
    const inM = timeToMinutes(inManual);
    const outM = timeToMinutes(outManual);
    if (!Number.isNaN(inM) && !Number.isNaN(outM)) {
      const effOut = outM < inM ? outM + 24 * 60 : outM;
      let work = Math.max(0, effOut - inM);
      if (!skipLunch && seg.lunchOutManual && seg.lunchInManual) {
        work = Math.max(0, work - lunchMinutesFromManual(seg, inM));
      }
      manualMins = work;
    }
  }

  const stored = typeof seg.workMinutes === 'number' ? seg.workMinutes : undefined;

  // 1) Stored when consistent with the manual signal (accurate + unedited).
  if (stored !== undefined && manualMins !== undefined && Math.abs(stored - manualMins) <= 1) {
    return stored;
  }
  // 2) Manual-derived when stored is absent or has diverged (edited shift).
  if (manualMins !== undefined) return manualMins;
  // 3) System-timestamp span when manual punch times are absent.
  if (inSys !== undefined && outSys !== undefined && outSys >= inSys) {
    const grossMin = Math.round((outSys - inSys) / (1000 * 60));
    let lunch = 0;
    if (!skipLunch) {
      lunch = lunchMinutesFromSystem(seg);
      if (lunch === 0 && (seg.lunchOutManual || seg.lunchInManual)) {
        const inM = timeToMinutes(seg.clockInManual);
        if (!Number.isNaN(inM)) lunch = lunchMinutesFromManual(seg, inM);
      }
    }
    return Math.max(0, grossMin - lunch);
  }
  // 4) Stored value as a last resort.
  return stored ?? 0;
}

/**
 * Fresh duration for a COMPLETE segment from its (corrected) timestamps, used by
 * the write-side `recalculateEntryTotals`.
 *
 * Prefers the system span (clockInSystem→clockOutSystem): after an edit the
 * `*System` epochs were just derived from the manual times by
 * `recomputeSegmentSystemTimestamps`, so the span IS the intended duration
 * (including a ≤1-minute clock-in/out edit that the stored value would wrongly
 * absorb via the hybrid's 1-min tolerance). For unedited segments it's the true
 * punch span, which keeps split-boundary second precision (23:32:00→23:59:59 = 28
 * min, matching the stored value).
 *
 * Unlike the read-side `computeSegmentWorkMinutes`, this NEVER returns a stale
 * stored `workMinutes` that predates an edit. Falls back to the manual heuristic
 * when there are no usable system timestamps, then the stored value.
 */
function computeFreshClosedSegmentMinutes(seg: TimeSegment): number {
  const skipLunch = seg.skipLunch === true;
  const inSys = typeof seg.clockInSystem === 'number' ? seg.clockInSystem : undefined;
  const outSys = typeof seg.clockOutSystem === 'number' ? seg.clockOutSystem : undefined;
  if (inSys !== undefined && outSys !== undefined && outSys >= inSys) {
    const grossMin = Math.round((outSys - inSys) / (1000 * 60));
    let lunch = 0;
    if (!skipLunch) {
      lunch = lunchMinutesFromSystem(seg);
      if (lunch === 0 && (seg.lunchOutManual || seg.lunchInManual)) {
        const inM = timeToMinutes(seg.clockInManual);
        if (!Number.isNaN(inM)) lunch = lunchMinutesFromManual(seg, inM);
      }
    }
    return Math.max(0, grossMin - lunch);
  }
  // No usable system span: manual heuristic (single-day wrap + lunch), else the
  // stored value (cleared here so the hybrid skips its "keep stored" tier).
  return computeSegmentWorkMinutes({ ...seg, workMinutes: undefined });
}

/**
 * Canonical WRITE-side entry-totals recalculation (SSOT). Given a doc's
 * segments (with manual punch fields already updated by an edit AND their
 * `*System` epochs refreshed by `recomputeSegmentSystemTimestamps`), recompute
 * each complete segment's `workMinutes` from the corrected timestamps and derive
 * the day `totalWorkMinutes` / `totalHours` — the values to persist atomically
 * alongside the edited segments so stored fields never lag the manual punch
 * times. Recomputes fresh from the timestamps (never keeps a stale stored value),
 * so even a 1-minute edit propagates to the total.
 *
 * Open segments (no clock-out) keep their stored/undefined workMinutes; their
 * live minutes are computed separately at read time.
 */
export function recalculateEntryTotals(segments: TimeSegment[]): {
  segments: TimeSegment[];
  totalWorkMinutes: number;
  totalHours: number;
} {
  const recomputed = segments.map((s) =>
    s.complete && s.clockOutManual ? { ...s, workMinutes: computeFreshClosedSegmentMinutes(s) } : s,
  );
  const totalWorkMinutes = recomputed.reduce(
    (sum, s) => sum + (s.complete ? s.workMinutes || 0 : 0),
    0,
  );
  return { segments: recomputed, totalWorkMinutes, totalHours: totalWorkMinutes / 60 };
}

/** Close an open segment with clock-out + compute its workMinutes (lunch-aware). */
export function closeActiveSegment(
  seg: TimeSegment,
  clockOutManual: string,
  clockOutSystem: number,
  skipLunch = false,
): TimeSegment {
  if (seg.complete) return seg; // idempotent

  const effectiveSkipLunch = skipLunch || seg.skipLunch === true;
  // Delegate to computeSegmentWorkMinutes so the close path and the report-time
  // normalization share identical duration logic (S6 cross-midnight + multi-day
  // via system timestamps). The fresh clock-out timestamp is passed as the
  // override since it is not yet on `seg`.
  const workM = computeSegmentWorkMinutes(
    { ...seg, clockOutManual, clockOutSystem, skipLunch: effectiveSkipLunch },
    clockOutSystem,
  );

  const out: TimeSegment = {
    ...seg,
    clockOutManual,
    clockOutSystem,
    workMinutes: workM,
    complete: true,
    skipLunch: effectiveSkipLunch,
  };
  return out;
}

/** Apply a lunch action to an open segment (start or end). Returns updated segment copy. */
export function applyLunchToSegment(
  seg: TimeSegment,
  action: 'start' | 'end' | 'skip',
  timeManual: string,
  timeSystem: number
): TimeSegment {
  if (seg.complete) return seg;
  if (action === 'skip') {
    const out: TimeSegment = { ...seg, skipLunch: true };
    return out;
  }
  if (action === 'start' && !seg.lunchOutManual) {
    return { ...seg, lunchOutManual: timeManual, lunchOutSystem: timeSystem };
  }
  if (action === 'end' && seg.lunchOutManual && !seg.lunchInManual) {
    return { ...seg, lunchInManual: timeManual, lunchInSystem: timeSystem };
  }
  return seg;
}

/**
 * Returns the currently-active (open, not yet clocked-out) segment, if any.
 *
 * Reads from `entry.segments[]` first (the canonical split-shift source). If
 * segments is empty but the entry has legacy `clockInManual` set and no
 * `clockOutManual`, synthesizes a current segment from the legacy top-level
 * fields. This handles the case where a clock-in was written by the legacy
 * `TodayEntry` UI (which only writes top-level fields, no `segments[]`).
 *
 * Also returns `entry.currentSegment` (the synthesized view exposed by
 * `mapEntry`) when the persisted segments are empty.
 */
export function getActiveSegment(entry: TimeEntry | null | undefined): TimeSegment | null {
  if (!entry) return null;

  // Voided/archived entries have no active shift. The legacy 1-entry-per-day
  // rule and the punchIn validator both need to treat these as "no open
  // shift" so test data cleanup (soft-voiding old docs) can recover state
  // without manually rewriting segments[].
  if (entry.status === 'voided' || entry.status === 'archived') return null;

  // Canonical: an open segment in the persisted array.
  if (entry.segments?.length) {
    const last = entry.segments[entry.segments.length - 1];
    if (last && !last.complete) return last;
  }

  // Fallback 1: synthesized current view from mapEntry (used when the doc has
  // BOTH legacy fields and segments[] that we deliberately excluded).
  const cur = entry.currentSegment;
  if (cur && !cur.complete) return cur;

  // Fallback 2: legacy half-baked doc (clockInManual written, no segments, no
  // currentSegment because mapEntry sees no clockInManual either). Build a
  // minimal open segment so the UI and validation recognize this as an open
  // shift. This is the case where the user clocked in via the legacy
  // TodayEntry form which only writes top-level fields.
  if (entry.clockInManual && !entry.clockOutManual && !entry.complete) {
    return {
      id: `${entry.id || entry.userId || 'unknown'}_legacy_current`,
      clockInManual: entry.clockInManual,
      clockInSystem: entry.clockInSystem,
      complete: false,
    };
  }

  return null;
}

/** True if the day has any open (in-progress) segment. */
export function hasOpenSegment(entry: TimeEntry | null | undefined): boolean {
  return getActiveSegment(entry) !== null;
}

/**
 * S7: Build a synchronized `segments[]` array + day total for a shift close.
 *
 * Centralizes the dual-write contract: whenever a shift is closed (clock-out
 * written), the corresponding segment in `segments[]` must be closed with
 * matching values AND `totalWorkMinutes` must reflect the sum. Without this,
 * a doc can end up with root `clockOutManual` set but `segments[]` stale —
 * which made `mapEntry` recompute wrong totals and, before the S1 fallback,
 * rendered "⚠️ Missing Clock Out" for valid closed shifts.
 *
 * Closes the shift via `closeActiveSegment` so the S6 cross-midnight wrap
 * and lunch deduction are identical to the punch flow. All close paths
 * (clockService.punchOut already does this inline; admin corrections in
 * TeamDashboard/AdminPanel; legacy TodayEntry submitClockOut + watchdog)
 * MUST route through this helper (or closeActiveSegment directly) so no
 * write path leaves the doc divergent.
 *
 * @param mode
 *   - 'replace': collapse to a single rebuilt closed segment (admin
 *     correction flow — the admin form represents one shift, so prior
 *     split-shift segments are dropped, matching the existing admin UX).
 *   - 'append': preserve prior archived (complete) segments and append the
 *     closed one (punch-out / legacy submit — preserves split-shift history).
 */
export function buildConsistentClosePatch(args: {
  clockIn: string;
  clockOut: string;
  skipLunch: boolean;
  lunchOut?: string;
  lunchIn?: string;
  clockOutSystem?: number;
  clockInSystem?: number;
  taskId?: string;
  existingSegments?: TimeSegment[];
  mode: 'replace' | 'append';
}): { segments: TimeSegment[]; totalWorkMinutes: number; closedSegment: TimeSegment } {
  // Synthesize an open segment from the raw fields, then close it via the
  // canonical helper so S6 wrap + lunch deduction match the punch flow.
  const openSeg: TimeSegment = {
    id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    clockInManual: args.clockIn,
    clockInSystem: args.clockInSystem,
    lunchOutManual: args.lunchOut,
    lunchInManual: args.lunchIn,
    skipLunch: args.skipLunch,
    complete: false,
  };
  if (args.taskId) openSeg.taskId = args.taskId;

  const closedSeg = closeActiveSegment(openSeg, args.clockOut, args.clockOutSystem ?? 0, args.skipLunch);

  const archived =
    args.mode === 'replace'
      ? [] // admin correction: collapse to single shift (matches admin form UX)
      : (args.existingSegments || []).filter((s) => s.complete); // append: keep prior closed shifts

  const segments = [...archived, stripUndefined(closedSeg)] as TimeSegment[];
  const totalWorkMinutes =
    archived.reduce((sum, s) => sum + (s.workMinutes || 0), 0) + (closedSeg.workMinutes || 0);

  return { segments, totalWorkMinutes, closedSegment: closedSeg };
}

/**
 * Map a `*Manual` field name to its `*System` epoch counterpart.
 * Returns undefined for unknown fields.
 */
export function fieldToSystemField(
  field: 'clockInManual' | 'lunchOutManual' | 'lunchInManual' | 'clockOutManual',
): 'clockInSystem' | 'lunchOutSystem' | 'lunchInSystem' | 'clockOutSystem' | undefined {
  switch (field) {
    case 'clockInManual': return 'clockInSystem';
    case 'lunchOutManual': return 'lunchOutSystem';
    case 'lunchInManual': return 'lunchInSystem';
    case 'clockOutManual': return 'clockOutSystem';
    default: return undefined;
  }
}

/**
 * Recompute a segment's `*System` epoch timestamps from its `*Manual` strings,
 * anchored to the segment's local calendar date in the employee's timezone.
 *
 * This keeps `*System` (the SSOT for instants) in sync with `*Manual` after a
 * manual edit. Without it, displays that prefer `*System` (Payroll Report time
 * rows, Team view) render the stale pre-edit instant while the recomputed
 * totals render the edited value — the "totals correct, time rows wrong" split.
 *
 * All four boundaries are recomputed (not just the edited one) because editing
 * clockIn can flip the cross-midnight wrap relationship for clockOut/lunch,
 * which would otherwise leave those `*System` instants on the wrong day. Only
 * fields that have a `*Manual` value are recomputed; absent boundaries keep
 * their existing `*System` (or stay undefined).
 *
 * @param seg         the segment (manual fields already updated by the edit)
 * @param anchorDate  the segment's local YYYY-MM-DD (seg.localDate or entry date)
 * @param timezone    the employee's IANA zone (required to interpret HH:MM)
 */
export function recomputeSegmentSystemTimestamps(
  seg: TimeSegment,
  anchorDate: string | undefined,
  timezone: string | undefined | null,
): TimeSegment {
  if (!anchorDate || !timezone) return seg;
  const clockIn = seg.clockInManual;
  const out: TimeSegment = { ...seg };

  // clockIn is the anchor — on its own date, no wrap.
  if (clockIn) {
    const ms = epochFromLocalWallTime(clockIn, anchorDate, timezone);
    if (typeof ms === 'number') out.clockInSystem = ms;
  }
  // lunch/clock-out are wrap-aware relative to the segment's clockIn.
  if (seg.lunchOutManual) {
    const ms = epochFromLocalWallTime(seg.lunchOutManual, anchorDate, timezone, clockIn);
    if (typeof ms === 'number') out.lunchOutSystem = ms;
  }
  if (seg.lunchInManual) {
    const ms = epochFromLocalWallTime(seg.lunchInManual, anchorDate, timezone, clockIn);
    if (typeof ms === 'number') out.lunchInSystem = ms;
  }
  if (seg.clockOutManual) {
    const ms = epochFromLocalWallTime(seg.clockOutManual, anchorDate, timezone, clockIn);
    if (typeof ms === 'number') out.clockOutSystem = ms;
  }
  return out;
}

/**
 * Segments to PRESERVE when an admin/manager corrects a shift via the
 * single-shift form: all persisted segments EXCEPT the one being edited.
 *
 * The single-shift edit form targets the current/last shift (the persisted
 * segment that mirrors the root `clockInManual`). Editing a split-shift day
 * must replace ONLY that targeted segment in-place — NOT collapse the whole
 * day to a single shift. The previous `buildConsistentClosePatch({mode:
 * 'replace'})` collapsed every segment into one, which (a) destroyed the other
 * shifts' minutes on save (data loss) and (b) made the modal preview show
 * "before" (the full multi-shift day) diverge from "after" (the collapsed
 * single shift) even with no edits.
 *
 * Identification: the edited segment is the LAST persisted segment when it
 * mirrors the root `clockInManual` (the dual-write invariant). If the last
 * segment does not mirror the root (legacy doc whose current shift lives only
 * in the top-level fields), ALL persisted segments are archived and preserved.
 */
export function getPreservedSegmentsForEdit(entry: {
  segments?: TimeSegment[];
  clockInManual?: string;
}): TimeSegment[] {
  const segs = entry.segments ?? [];
  const last = segs[segs.length - 1];
  const lastMirrorsRoot = !!last && last.clockInManual === entry.clockInManual;
  return lastMirrorsRoot ? segs.slice(0, -1) : segs;
}
