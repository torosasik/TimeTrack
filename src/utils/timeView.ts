/**
 * Admin timezone view conversion (Req 4).
 *
 * Admin/Manager analysis views (Payroll, History, Audit, Metrics, Team) can
 * render shift times in either:
 *   - "local": the EMPLOYEE's own local timezone (default), or
 *   - "pt":    America/Los_Angeles (California Time), for administrative review.
 *
 * The conversion uses the absolute epoch-millis system timestamps
 * (clockInSystem / clockOutSystem / lunchOutSystem / lunchInSystem), which are
 * timezone-independent. The HH:MM *Manual strings are used only as a fallback
 * for legacy rows that lack system timestamps (they are already stored in the
 * entry's own zone, so they are shown as-is).
 *
 * Pure functions (no firebase) so they are jest-testable.
 */

import { getEmployeeTimezone } from './timeCalculations';

export type TimeViewMode = 'local' | 'pt';

export const PT_ZONE = 'America/Los_Angeles';

/** Resolve the IANA zone for a view mode. 'pt' → PT; 'local' → employee tz. */
export function zoneForMode(mode: TimeViewMode, employeeTimezone?: string | null): string {
  return mode === 'pt' ? PT_ZONE : getEmployeeTimezone(employeeTimezone ?? undefined);
}

/**
 * Calendar-day offset between two epoch-ms instants as seen in `timeZone`:
 * 0 when both land on the same calendar date in that zone, 1 when `targetMs`
 * falls on the next date, etc. Used for the "+Nd" badges in the Payroll and
 * Analytics daily breakdowns. The zone MUST be the zone the row's times are
 * displayed in (see zoneForMode) — comparing PT dates while rendering
 * employee-local times produced false-positive "+1d" badges on same-local-day
 * shifts that merely straddled the PT midnight (e.g. 12:00 AM → 11:59 PM).
 */
export function calendarDayOffsetInZone(anchorMs: number, targetMs: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const a = fmt.format(new Date(anchorMs));
  const b = fmt.format(new Date(targetMs));
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  if (!ay || !by) return 0;
  const dayA = Date.UTC(ay, am - 1, ad);
  const dayB = Date.UTC(by, bm - 1, bd);
  return Math.round((dayB - dayA) / (1000 * 60 * 60 * 24));
}

/** HH:MM (24h) of an instant in the given zone. */
export function hhmmInZone(epochMs: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
}

/** HH:MM (12h AM/PM) of an instant in the given zone. */
export function hhmm12InZone(epochMs: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(epochMs));
}

/**
 * Display a single boundary time for the given view mode, as a 24h "HH:MM"
 * string (composable with the views' existing HH:MM→12h renderers).
 * - `epochMs`: the absolute system timestamp for the boundary (preferred).
 * - `manualFallback`: the stored HH:MM string (used when epochMs is absent).
 * - `mode`: 'local' | 'pt'.
 * - `employeeTimezone`: the employee's local zone (for 'local' mode).
 * Returns a 24h "HH:MM" string, or the fallback when no time exists.
 */
export function displayTimeForView(
  epochMs: number | undefined,
  manualFallback: string | undefined,
  mode: TimeViewMode,
  employeeTimezone?: string | null,
): string | undefined {
  if (typeof epochMs === 'number') {
    return hhmmInZone(epochMs, zoneForMode(mode, employeeTimezone));
  }
  return manualFallback;
}

// ---------------------------------------------------------------------------
// Per-local-date explosion (cross-midnight split attribution)
// ---------------------------------------------------------------------------

export interface ExplodableSegment {
  id?: string;
  localDate?: string;
  splitFromMidnight?: boolean;
  workMinutes?: number;
  complete?: boolean;
  clockInManual?: string;
  clockOutManual?: string;
  clockInSystem?: number;
  clockOutSystem?: number;
  lunchOutManual?: string;
  lunchInManual?: string;
  lunchOutSystem?: number;
  lunchInSystem?: number;
  skipLunch?: boolean;
}

export interface ExplodableDoc {
  id?: string;
  userId?: string;
  date?: string;
  workDate?: string;
  segments?: ExplodableSegment[];
  currentSegment?: ExplodableSegment | null;
  clockInManual?: string;
  clockOutManual?: string;
  clockInSystem?: number;
  clockOutSystem?: number;
  lunchOutManual?: string;
  lunchInManual?: string;
  lunchOutSystem?: number;
  lunchInSystem?: number;
  skipLunch?: boolean;
  complete?: boolean;
  totalWorkMinutes?: number;
  totalHours?: number;
  /** Display-layer marker: true when this doc was produced by the cross-midnight
   * explosion (it is a synthetic view, not a persisted doc). */
  synthetic?: boolean;
  /** Display-layer: the persisted source doc id a synthetic exploded entry was
   * derived from. Any WRITE (edit/void/correction) must target this id, not the
   * synthetic `id`. */
  sourceId?: string;
}

/**
 * Split a doc whose persisted segments carry attributed `localDate`s (written
 * by the automatic local-midnight split) into one synthetic doc per local
 * calendar date. This repairs the pre-fix cross-midnight shape, where a
 * 23:32→00:28 shift was split into 23:32→23:59 + 00:00→00:28 but BOTH parts
 * were stored on the punch-in day's doc — causing triple rows in the edit
 * modal (the synthesized top-level "current" 23:32→00:28 appeared as a third
 * shift) and single-day aggregation in payroll/history.
 *
 * Docs whose segments have no differing localDate are returned unchanged
 * (zero impact on normal single-day or same-day split-shift docs). Works on
 * hydrated TimeEntry objects and raw Firestore DocumentData alike.
 */
export function explodeDocBySegmentLocalDate<T extends ExplodableDoc>(doc: T): T[] {
  const segs = doc.segments ?? [];
  const fallbackDate = doc.workDate ?? doc.date;
  // The persisted source doc id. Hydrated entries carry `id`; raw Firestore
  // docs (which may omit it) are reconstructed from `${userId}_${workDate}` —
  // the timeEntries collection's id pattern. This is the id any WRITE must
  // target (via writeDocId).
  const sourceId = doc.id ?? (doc.userId && fallbackDate ? `${doc.userId}_${fallbackDate}` : undefined);
  const dates: string[] = [];
  for (const s of segs) {
    const d = s.localDate ?? fallbackDate;
    if (d && !dates.includes(d)) dates.push(d);
  }
  if (dates.length <= 1) return [doc];
  return dates.map((date) => {
    const dateSegs = segs.filter((s) => (s.localDate ?? fallbackDate) === date);
    const mins = dateSegs.reduce((sum, s) => sum + (s.workMinutes ?? 0), 0);
    const first = dateSegs[0];
    const lastClosed = [...dateSegs].reverse().find((s) => s.clockOutManual) ?? dateSegs[dateSegs.length - 1];
    // Per-part lunch boundaries (from THIS date's segments, not the doc's
    // top-level fields) so day-level flag logic (short/long lunch) computed on
    // the exploded part reflects that part, not the whole cross-midnight shift.
    const firstLunchOut = dateSegs.find((s) => s.lunchOutManual);
    const lastLunchIn = [...dateSegs].reverse().find((s) => s.lunchInManual);
    return {
      ...doc,
      // Synthetic display id — `${sourceId}@${date}`. The `@` cannot appear in
      // a real `${uid}_${date}` Firestore id, so a synthetic part can NEVER
      // collide with a real same-date doc (e.g. a normal 07/30 shift vs an
      // exploded 07/29→07/30 part). Unique per (source, date) for React keys.
      // Never used for Firestore reads/writes (writeDocId uses sourceId).
      id: `${sourceId ?? doc.userId ?? 'entry'}@${date}`,
      date,
      workDate: date,
      segments: dateSegs,
      // Each exploded doc stands alone for its date; drop the synthesized
      // top-level "current" view so it cannot appear as a phantom extra shift.
      currentSegment: undefined,
      clockInManual: first?.clockInManual,
      clockOutManual: lastClosed?.clockOutManual,
      clockInSystem: first?.clockInSystem,
      clockOutSystem: lastClosed?.clockOutSystem,
      lunchOutManual: firstLunchOut?.lunchOutManual,
      lunchInManual: lastLunchIn?.lunchInManual,
      lunchOutSystem: firstLunchOut?.lunchOutSystem,
      lunchInSystem: lastLunchIn?.lunchInSystem,
      skipLunch: dateSegs.length > 0 && dateSegs.every((s) => s.skipLunch === true),
      complete: dateSegs.length > 0 && dateSegs.every((s) => s.complete === true),
      totalWorkMinutes: mins,
      totalHours: mins / 60,
      // Mark as a synthetic display view and record the persisted source doc id
      // so any write (edit/void/correction) targets the real doc, not this
      // synthetic `${sourceId}@${date}` id (which is display-only).
      synthetic: true,
      sourceId,
    } as T;
  });
}

/**
 * Resolve the persisted Firestore doc id a (possibly synthetic exploded) entry
 * should be written against. Real docs return their own id; synthetic exploded
 * entries return their `sourceId` (the persisted cross-midnight doc they were
 * derived from). Segment ids are unaffected — a synthetic part's segment still
 * lives on the source doc.
 */
export function writeDocId<T extends ExplodableDoc>(entry: T): string {
  return entry.synthetic && entry.sourceId ? entry.sourceId : (entry.id ?? '');
}

/** Explode a list of docs (see explodeDocBySegmentLocalDate). */
export function explodeDocsBySegmentLocalDate<T extends ExplodableDoc>(docs: T[]): T[] {
  return docs.flatMap((d) => explodeDocBySegmentLocalDate(d));
}
