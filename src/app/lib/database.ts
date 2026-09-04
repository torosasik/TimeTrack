import { collection, doc, getDoc, getDocs, orderBy, query, Timestamp, updateDoc, where, limit, startAfter, deleteDoc, addDoc, setDoc } from 'firebase/firestore';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import type { User } from './auth';
import { stripUndefined, closeActiveSegment, computeSegmentWorkMinutes, recalculateEntryTotals, recomputeSegmentSystemTimestamps, fieldToSystemField } from './segmentOps';
import { deriveSegmentWorkMinutes, epochFromLocalWallTime, getEmployeeTimezone } from '../../utils/timeCalculations';
import { validateSegmentChronology, getFuturePunchError, getSegmentOverlapError } from '../../utils/timeValidation';
import { auditLogService } from '../../services/auditLogService';
import { fetchGlobalSettings } from '../../services/systemSettingsService';

/**
 * A single continuous work session ("shift"). A day may contain multiple
 * segments when the user pauses and resumes work (split shifts).
 * Legacy single-entry docs with no `segments[]` behave as a single-segment day.
 */
export interface TimeSegment {
  id: string;               // stable per-segment id (timestamp-based)
  clockInManual?: string;
  clockInSystem?: number;
  lunchOutManual?: string;
  lunchOutSystem?: number;
  lunchInManual?: string;
  lunchInSystem?: number;
  clockOutManual?: string;
  clockOutSystem?: number;
  skipLunch?: boolean;
  workMinutes?: number;     // minutes worked in this segment
  complete?: boolean;       // clockOut recorded
  taskId?: string;          // Dragme task id (optional)
  autoClosed?: boolean;     // set when watchdog auto-closes the segment
  /** Set when the 1-hour lunch auto-end guardrail ends an in-progress lunch. */
  autoEndedLunch?: boolean;
  /** Set when a server-side guardrail action affected this segment. */
  flagged?: boolean;
  /** Local calendar date (YYYY-MM-DD) this segment is attributed to. Set by the
   * automatic local-midnight split; absent on single-day segments (their date
   * is the owning doc's workDate). */
  localDate?: string;
  /** Marks a segment produced by the automatic local-midnight split. */
  splitFromMidnight?: boolean;
}

export interface TimeEntry {
  id: string;               // Firestore doc id (uid_date)
  userId: string;
  date: string;             // YYYY-MM-DD (derived from workDate at hydration)
  /** Logical work date as stored on the doc (employee local calendar date).
   * Optional on hydrated entries — `date` always mirrors it. */
  workDate?: string;

  /** Split-shift segments for the day. Always populated (at least 1 for legacy). */
  segments?: TimeSegment[];

  clockInManual?: string;
  clockInSystem?: number;   // millis
  lunchOutManual?: string;
  lunchOutSystem?: number;  // millis
  lunchInManual?: string;
  lunchInSystem?: number;   // millis
  clockOutManual?: string;

  // Notification system locks to prevent repeated spams per day
  lunch_reminder_sent_at?: Timestamp | number | null;
  clockout_reminder_sent_at?: Timestamp | number | null;
  longshift_reminder_sent_at?: Timestamp | number | null;
  clockOutSystem?: number;  // millis

  skipLunch?: boolean;

  // Raw minutes stored in Firestore (used for payroll/audit calculations)
  totalWorkMinutes?: number;
  regularMinutes?: number;
  otMinutes?: number;
  doubleTimeMinutes?: number;

  totalHours?: number;
  regularHours?: number;
  overtimeHours?: number;   // 1.5x
  doubleTimeHours?: number; // 2x

  complete: boolean;
  flags?: string[];
  adminNotes?: string;
  currentStep: number;      // 0-4 (UI convenience)

  /** Optional employee-written shift note (<=250 chars) captured at clock-out
   * for Remote employees via the Daily Report modal. Empty string when the
   * employee dismisses the modal without entering text. */
  dailyReport?: string;

  correctionRequested?: boolean;
  anomalyFlag?: boolean;

  /** Dragme task id (optional, dual-written at entry level by legacy flows). */
  taskId?: string | null;

  status?: 'active' | 'corrected' | 'voided' | 'archived';

  completedAt?: number;     // millis

  /** Server-side auto-guardrail markers (10 PM / 12h auto-close). */
  autoClosed?: boolean;
  /** Server-side 1-hour lunch auto-end marker. */
  autoEndedLunch?: boolean;
  /** Set when a server-side auto-guardrail action touched this entry. */
  flagged?: boolean;

  /** Synthesized current-segment view exposed by mapEntry (not persisted). */
  currentSegment?: TimeSegment | null;

  /** Display-layer marker set by the cross-midnight localDate explosion
   * (explodeDocsBySegmentLocalDate). True when this entry is a synthetic view,
   * not a persisted doc. Never stored. */
  synthetic?: boolean;
  /** Display-layer: the persisted source doc id a synthetic exploded entry was
   * derived from. Writes (edit/void/correction) must target this id via
   * writeDocId(), not the synthetic `id`. Never stored. */
  sourceId?: string;
}

export interface CorrectionRequest {
  id: string;
  employee_id: string;
  employee_name: string;
  requested_date: string;       // YYYY-MM-DD
  issue_type: string;
  notes: string;
  suggested_time?: string;

  // Before/After comparison
  original_clock_in?: string;
  original_clock_out?: string;
  original_lunch?: string;
  requested_clock_in?: string;
  requested_clock_out?: string;
  requested_lunch?: string;

  status: 'Open' | 'In Progress' | 'Resolved' | 'Rejected';
  resolution_note?: string;
  rejection_reason?: string;
  created_at: number;           // millis
  updated_at?: number;
  updated_by?: string;
}

type FirestoreTimeEntry = DocumentData;

/** Structural type for Firestore Timestamp-like values (avoids `any` casts). */
interface TimestampLike {
  toDate(): Date;
}

function tsToMillis(ts: unknown): number | undefined {
  if (!ts) return undefined;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  if (ts && typeof (ts as TimestampLike).toDate === 'function') return (ts as TimestampLike).toDate().getTime();
  return undefined;
}

function minutesToHours(mins: unknown): number | undefined {
  if (mins === null || mins === undefined) return undefined;
  const n = Number(mins);
  if (Number.isNaN(n)) return undefined;
  return n / 60;
}

/** Compute minutes for the currently-active segment using its clock/lunch fields. */
function deriveCurrentSegmentMinutes(e: Partial<TimeEntry>, _archived: TimeSegment[]): number | undefined {
  // If totalWorkMinutes is present and this is a fresh single-segment doc, prefer it minus archived.
  if (!e.clockInManual) return undefined;
  if (e.clockOutManual) {
    // Delegate to the shared canonical helper so the lunch-aware arithmetic
    // stays identical to TodayEntry's submit flows. Returns undefined for open
    // shifts (no clockOut) so `current.workMinutes` is undefined and the
    // mapEntry override adds 0 via `?? 0`.
    return deriveSegmentWorkMinutes(
      e.clockInManual,
      e.clockOutManual,
      e.skipLunch,
      e.lunchOutManual,
      e.lunchInManual,
    );
  }
  return undefined;
}

export function mapEntry(id: string, data: FirestoreTimeEntry): TimeEntry {
  const date = String(data.workDate || data.date || '');
  const currentStepRaw = data.currentStep;
  const complete = data.dayComplete === true;
  const skipLunch = data.lunchSkipped === true;
  const currentStep =
    complete || currentStepRaw === 'complete'
      ? 4
      : typeof currentStepRaw === 'number'
        ? Math.max(0, Math.min(3, currentStepRaw - 1))
        : 0;

  const entry: TimeEntry = {
    id,
    userId: String(data.userId || ''),
    date,
    clockInManual: data.clockInManual || undefined,
    clockInSystem: tsToMillis(data.clockInSystemTime ?? data.clockInSystem),
    lunchOutManual: data.lunchOutManual || undefined,
    lunchOutSystem: tsToMillis(data.lunchOutSystemTime ?? data.lunchOutSystem),
    lunchInManual: data.lunchInManual || undefined,
    lunchInSystem: tsToMillis(data.lunchInSystemTime ?? data.lunchInSystem),
    clockOutManual: data.clockOutManual || undefined,
    lunch_reminder_sent_at: data.lunch_reminder_sent_at || null,
    clockout_reminder_sent_at: data.clockout_reminder_sent_at || null,
    longshift_reminder_sent_at: data.longshift_reminder_sent_at || null,
    clockOutSystem: tsToMillis(data.clockOutSystemTime ?? data.clockOutSystem),
    skipLunch,
    totalWorkMinutes: typeof data.totalWorkMinutes === 'number' ? data.totalWorkMinutes : undefined,
    regularMinutes: typeof data.regularMinutes === 'number' ? data.regularMinutes : undefined,
    otMinutes: typeof data.otMinutes === 'number' ? data.otMinutes : undefined,
    doubleTimeMinutes: typeof data.doubleTimeMinutes === 'number' ? data.doubleTimeMinutes : undefined,
    totalHours: minutesToHours(data.totalWorkMinutes),
    regularHours: minutesToHours(data.regularMinutes),
    overtimeHours: minutesToHours(data.otMinutes),
    doubleTimeHours: minutesToHours(data.doubleTimeMinutes),
    complete,
    currentStep,
    adminNotes: data.correctionNotes || data.notes || undefined,
    correctionRequested: data.correctionRequested === true,
    anomalyFlag: data.anomaly_flag === true,
    status: data.status || 'active',
    completedAt: tsToMillis(data.completedAt),
    autoClosed: data.autoClosed === true,
    autoEndedLunch: data.autoEndedLunch === true,
    flagged: data.flagged === true,
    // Daily Report (Remote clock-out note) — top-level day field; mapped so the
    // punch-status read can pre-fill the modal on a same-day second shift.
    dailyReport: typeof data.dailyReport === 'string' ? data.dailyReport : undefined,
  };

  // --- Split-shift segments ---------------------------------------------
  // Firestore stores *archived* segments in `segments[]`; the current (active
  // or most-recently-completed) segment lives in the legacy top-level fields.
  // Hydrated entry.segments = [...archived, current (if present)].
  const archivedRaw = Array.isArray(data.segments) ? data.segments : [];
  const archived: TimeSegment[] = archivedRaw.map((s: DocumentData, i: number) => {
    const out: TimeSegment = {
      id: String(s.id ?? `${id}_arch_${i}`),
      clockInManual: s.clockInManual || undefined,
      clockInSystem: tsToMillis(s.clockInSystemTime ?? s.clockInSystem),
      lunchOutManual: s.lunchOutManual || undefined,
      lunchOutSystem: tsToMillis(s.lunchOutSystemTime ?? s.lunchOutSystem),
      lunchInManual: s.lunchInManual || undefined,
      lunchInSystem: tsToMillis(s.lunchInSystemTime ?? s.lunchInSystem),
      clockOutManual: s.clockOutManual || undefined,
      clockOutSystem: tsToMillis(s.clockOutSystemTime ?? s.clockOutSystem),
      skipLunch: s.skipLunch === true || s.lunchSkipped === true,
      workMinutes: typeof s.workMinutes === 'number' ? s.workMinutes : undefined,
      // The "complete: true" default was a relic of the assumption that
      // Firestore's `segments[]` is always archived. In practice, `punchIn`
      // dual-writes a fresh OPEN segment into `segments[]` (alongside the
      // legacy top-level fields). Forcing `complete: true` here hid the
      // open segment from getActiveSegment and caused the ClockPunch UI to
      // flip to "CLOCKED OUT" right after a successful clock-in. Respect the
      // segment's actual persisted value instead.
      complete: s.complete === true,
      autoClosed: s.autoClosed === true,
      autoEndedLunch: s.autoEndedLunch === true,
      flagged: s.flagged === true,
      // Local-midnight split attribution fields (present on split segments).
      localDate: typeof s.localDate === 'string' ? s.localDate : undefined,
      splitFromMidnight: s.splitFromMidnight === true,
    };
    if (s.taskId) out.taskId = s.taskId; // omit when not set; never write undefined
    return out;
  });

  // S1: Fallback for dual-write divergence. Some docs end up with a complete
  // shift persisted in segments[] but the corresponding top-level manual
  // field missing (root clockOutManual not dual-written). Without this
  // fallback, HistoryView/TeamDashboard render "⚠️ Missing Clock Out" /
  // "Incomplete" for a valid closed shift. Resolve the effective manual
  // fields from the last persisted segment when the root field is absent.
  // Applied before `current` synthesis so the current-view also reflects
  // the real clock-out, and the existing coveredByArchived dedup keeps
  // totals correct (no double-count).
  //
  // GUARD: only inherit clock-out/lunch from the last persisted segment when
  // the top-level clockIn is absent (legacy doc) OR matches that segment's
  // clockIn (same shift, dual-write divergence). If the top-level clockIn
  // belongs to a DIFFERENT (newer, open) shift, the persisted segment is a
  // prior CLOSED shift — inheriting its clockOutManual/lunch would falsely
  // mark the open shift complete ("looks clocked out" bug on split-shift
  // docs whose open seg2 lives only in top-level fields while segments[]
  // ends in the closed seg1).
  const lastPersistedSeg = archived.length ? archived[archived.length - 1] : null;
  if (lastPersistedSeg) {
    if (!entry.clockInManual && lastPersistedSeg.clockInManual) entry.clockInManual = lastPersistedSeg.clockInManual;
    const sameShift =
      !entry.clockInManual || entry.clockInManual === lastPersistedSeg.clockInManual;
    if (sameShift) {
      if (!entry.clockOutManual && lastPersistedSeg.clockOutManual) entry.clockOutManual = lastPersistedSeg.clockOutManual;
      if (!entry.lunchOutManual && lastPersistedSeg.lunchOutManual) entry.lunchOutManual = lastPersistedSeg.lunchOutManual;
      if (!entry.lunchInManual && lastPersistedSeg.lunchInManual) entry.lunchInManual = lastPersistedSeg.lunchInManual;
    }
  }

  const current: TimeSegment | null = entry.clockInManual
    ? (() => {
        // Build the current segment WITHOUT undefined fields. Firestore rejects
        // any field with value `undefined`; if this segment is later written
        // back to the document (e.g. via toggleLunch's updateDoc), the whole
        // write fails. We use stripUndefined on the entry-derived fields then
        // force-include the always-present ones.
        const fromEntry: Partial<TimeSegment> = {
          clockInManual: entry.clockInManual,
          clockInSystem: entry.clockInSystem,
          lunchOutManual: entry.lunchOutManual,
          lunchOutSystem: entry.lunchOutSystem,
          lunchInManual: entry.lunchInManual,
          lunchInSystem: entry.lunchInSystem,
          clockOutManual: entry.clockOutManual,
          clockOutSystem: entry.clockOutSystem,
          skipLunch: entry.skipLunch,
          workMinutes: deriveCurrentSegmentMinutes(entry, archived),
        };
        const out: TimeSegment = {
          id: `${id}_current`,
          complete: !!entry.clockOutManual,
          autoClosed: data.autoClosed === true,
          autoEndedLunch: data.autoEndedLunch === true,
          ...stripUndefined(fromEntry),
        };
        if (data.taskId) out.taskId = data.taskId; // omit when not set
        return out;
      })()
    : null;

  // DEDUP: historical data has accumulated multiple `${id}_current` segments
  // because older versions of the code (and writes that round-trip through this
  // same mapEntry) appended a new current segment on every read. If we keep all
  // of them, every subsequent write to `segments` grows the array by one copy,
  // and Firestore's "no undefined" check fires because some legacy segments
  // don't have the fields our newer code expects. Keep only one segment per id,
  // preferring the LAST occurrence (most recent data).
  const dedup = (segs: TimeSegment[]): TimeSegment[] => {
    const byId = new Map<string, TimeSegment>();
    for (const s of segs) byId.set(s.id, s);
    return Array.from(byId.values());
  };

  // CRITICAL DESIGN NOTE:
  // `entry.segments` is meant to be the PERSISTED segments (the ones in the
  // Firestore document). The synthesized "current" is a *view* for UI / clock
  // state, NOT a stored object. If we put the synthesized current into
  // entry.segments, then every write (toggleLunch, punchOut) that uses
  // pre.segments as the source for the next write will round-trip the
  // synthesized current back to Firestore, growing the array indefinitely.
  //
  // So: entry.segments = persisted segments only. `current` is exposed on the
  // entry separately (see below) for UI components.
  if (current) {
    // The current segment is a view, not a stored object. Remove any
    // legacy `${id}_current` rows from the persisted list (older code wrote
    // them into segments[]).
    const persistedOnly = archived.filter((s) => s.id !== `${id}_current`);
    entry.segments = dedup(persistedOnly);
  } else {
    entry.segments = dedup(archived);
  }

  // Expose the current segment on the entry for UI consumers.
  entry.currentSegment = current;

  // SSOT: derive the day total via the single canonical reader (getEntryTotals)
  // so every view — History/Team/Audit (mapEntry) and Payroll (rebuild) — shows
  // identical, edit-current totals. It recomputes each segment via the hybrid
  // computeSegmentWorkMinutes (manual-primary when the stored value has
  // diverged), so a within-24h manual edit propagates immediately instead of
  // being shadowed by stale stored workMinutes / system timestamps.
  const totals = getEntryTotals(entry);
  entry.totalWorkMinutes = totals.totalWorkMinutes;
  entry.totalHours = totals.totalHours;

  // Flags are not stored in Firestore by default; compute basic flags for UI
  entry.flags = calculateFlags(entry);
  return entry;
}

// Segment operation helpers live in segmentOps.ts so they can be unit-tested
// without importing the firebase-firestore web SDK. Re-exported here for
// backward compat with existing callers.
export {
  stripUndefined,
  createInitialSegment,
  closeActiveSegment,
  applyLunchToSegment,
  getActiveSegment,
  hasOpenSegment,
  buildConsistentClosePatch,
  computeSegmentWorkMinutes,
  recalculateEntryTotals,
  recomputeSegmentSystemTimestamps,
  fieldToSystemField,
  getPreservedSegmentsForEdit,
} from './segmentOps';

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function calculateTotalHours(entry: Partial<TimeEntry>): number {
  if (!entry.clockInManual || !entry.clockOutManual) return 0;
  const clockIn = timeToMinutes(entry.clockInManual);
  const clockOut = timeToMinutes(entry.clockOutManual);
  // S6: cross-midnight wrap (see segmentOps.closeActiveSegment). A clock-out
  // earlier than clock-in means the shift crossed midnight; add 24h. Lunch
  // times are normalized against the same clock-in anchor so a midnight-
  // straddling lunch is subtracted correctly.
  const effClockOut = clockOut < clockIn ? clockOut + 24 * 60 : clockOut;
  let totalMinutes = effClockOut - clockIn;
  if (entry.lunchOutManual && entry.lunchInManual && !entry.skipLunch) {
    const lo = timeToMinutes(entry.lunchOutManual);
    const li = timeToMinutes(entry.lunchInManual);
    const effLo = lo < clockIn ? lo + 24 * 60 : lo;
    const effLi = li < clockIn ? li + 24 * 60 : li;
    totalMinutes -= Math.max(0, effLi - effLo);
  }
  return Math.max(0, totalMinutes / 60);
}

/**
 * Canonical READ-side entry totals (SSOT). Derives `totalWorkMinutes` and
 * `totalHours` strictly from the canonical segments[] / manual punch fields,
 * recomputing each segment via `computeSegmentWorkMinutes` (hybrid: stored when
 * consistent with the manual signal, else the manual punch times). It NEVER
 * measures raw un-updated `clockInSystem`/`clockOutSystem` timestamps alone —
 * those go stale after a manual edit, so the manual punch fields are the
 * source of truth for whether the stored value is still valid.
 *
 * All views (History/Team/Audit via mapEntry, Payroll via rebuild, and the
 * summary cards) consume this so an edit propagates identically everywhere.
 *
 * @param entry  a hydrated TimeEntry (segments + currentSegment set), or a
 *               partial with top-level manual fields for the no-segments case.
 */
export function getEntryTotals(entry: Partial<TimeEntry>): { totalWorkMinutes: number; totalHours: number } {
  const segs = entry.segments ?? [];
  const current = entry.currentSegment ?? null;

  // No persisted segments: keep the stored total, or derive from the top-level
  // manual punch fields (wrap-aware) when it is missing.
  if (segs.length === 0) {
    if (entry.totalWorkMinutes !== undefined) {
      return { totalWorkMinutes: entry.totalWorkMinutes, totalHours: entry.totalWorkMinutes / 60 };
    }
    if (entry.complete && entry.clockInManual && entry.clockOutManual) {
      const mins = calculateTotalHours(entry) * 60;
      return { totalWorkMinutes: mins, totalHours: mins / 60 };
    }
    return { totalWorkMinutes: 0, totalHours: 0 };
  }

  // Recompute each persisted segment via the hybrid SSOT segment function.
  const archivedMins = segs.reduce((sum, s) => sum + computeSegmentWorkMinutes(s), 0);

  // Synthesized current (from top-level) — add only when NOT already covered by
  // a persisted segment (dual-write / split-chain dedup), else it double-counts.
  let currentMins = 0;
  if (current) {
    if (current.complete) {
      const coveredExact = segs.some(
        (s) => s.clockInManual === current.clockInManual && s.clockOutManual === current.clockOutManual,
      );
      const coveredSplitChain =
        segs[0].clockInManual === current.clockInManual &&
        segs[segs.length - 1].clockOutManual === current.clockOutManual;
      currentMins = coveredExact || coveredSplitChain ? 0 : current.workMinutes ?? 0;
    } else {
      // Open shift — live minutes (current.workMinutes is undefined for open,
      // so this contributes 0 to the persisted day total until clock-out).
      currentMins = current.workMinutes ?? 0;
    }
  }

  const total = archivedMins + currentMins;
  return { totalWorkMinutes: total, totalHours: total / 60 };
}

export function calculateFlags(entry: TimeEntry): string[] {
  const flags: string[] = [];

  // Server-side auto-guardrail flags — surface regardless of completion state,
  // because an auto-ended lunch leaves the shift OPEN (entry.complete === false)
  // yet still must appear in the Admin Dashboard's Flags count / filtered list.
  const segs = entry.segments ?? [];
  // Exclude routine local-midnight-split portions: the splitter stamps
  // autoClosed: true on every cross-midnight Day-1 part (midnightSplit.ts),
  // which is NOT a guardrail action. A split part only counts as a guardrail
  // action when it is also flagged (the cron/repair writers set flagged).
  const isGuardrailClose = (s: { autoClosed?: boolean; splitFromMidnight?: boolean; flagged?: boolean } | undefined) =>
    s?.autoClosed === true && (s.splitFromMidnight !== true || s.flagged === true);
  const autoClosed =
    entry.autoClosed === true ||
    isGuardrailClose(entry.currentSegment ?? undefined) ||
    segs.some((s) => isGuardrailClose(s));
  const autoEndedLunch =
    entry.autoEndedLunch === true ||
    entry.currentSegment?.autoEndedLunch === true ||
    segs.some((s) => s.autoEndedLunch === true);
  if (autoClosed) flags.push('auto_closed_shift');
  if (autoEndedLunch) flags.push('auto_ended_lunch');

  if (!entry.complete) return flags;

  // Short/long lunch
  if (entry.lunchOutManual && entry.lunchInManual && !entry.skipLunch) {
    const duration = timeToMinutes(entry.lunchInManual) - timeToMinutes(entry.lunchOutManual);
    if (duration < 20) flags.push('short_lunch');
    if (duration > 90) flags.push('long_lunch');
  }

  // Very long/short day
  if (entry.totalHours !== undefined) {
    if (entry.totalHours > 11) flags.push('very_long_day');
    if (entry.totalHours > 0 && entry.totalHours < 4) flags.push('very_short_day');
  }

  // Anomalies detected at submission time by the user bypassing warnings
  if (entry.anomalyFlag) {
    flags.push('anomaly_detected');
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Punch segment helpers (Clock Agent owns — minimal addition for atomic punch flows)
// These are the canonical way to create/close segments in the TimeSegment model.
// New clockService.ts MUST use these + runTransaction for double-punch safety.
// Legacy flat fields are dual-written for backward compat with History/Payroll.
// ---------------------------------------------------------------------------

class DatabaseService {
  calculateTotalHours(entry: Partial<TimeEntry>): number {
    return calculateTotalHours(entry);
  }

  calculateFlags(entry: TimeEntry): string[] {
    return calculateFlags(entry);
  }

  async getTimeEntry(userId: string, date: string): Promise<TimeEntry | null> {
    const entryId = `${userId}_${date}`;
    const snap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!snap.exists()) return null;
    return mapEntry(snap.id, snap.data());
  }

  /**
   * Fetch a single time entry by its Firestore doc id (`${uid}_${date}`).
   * Used to resolve the persisted SOURCE doc of a synthetic exploded
   * cross-midnight part when it isn't present in a component's loaded list
   * (e.g. filtered out / not yet loaded) — so writes always target the real
   * doc, never the synthetic `${sourceId}@${date}` display id.
   */
  async getTimeEntryById(docId: string): Promise<TimeEntry | null> {
    const snap = await getDoc(doc(db, 'timeEntries', docId));
    if (!snap.exists()) return null;
    return mapEntry(snap.id, snap.data());
  }

  async getTimeEntriesForUser(userId: string): Promise<TimeEntry[]> {
    const q = query(
      collection(db, 'timeEntries'),
      where('userId', '==', userId),
      orderBy('workDate', 'desc')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => mapEntry(d.id, d.data()));
  }

  async getTimeEntriesForUserInRange(userId: string, startDate: string, endDate: string): Promise<TimeEntry[]> {
    const q = query(
      collection(db, 'timeEntries'),
      where('userId', '==', userId),
      where('workDate', '>=', startDate),
      where('workDate', '<=', endDate),
      orderBy('workDate', 'desc')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => mapEntry(d.id, d.data()));
  }

  /**
   * Fetch all time entries, paginating through Firestore so we don't silently
   * truncate payroll at 500 docs. Returns ALL entries ordered by workDate desc.
   *
   * Cost: O(N) reads. The previous 500-cap silently dropped entries and broke
   * biweekly payroll for any company with more than ~5 weeks of history.
   */
  async getAllTimeEntries(): Promise<TimeEntry[]> {
    const PAGE_SIZE = 500;
    const all: TimeEntry[] = [];
    let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null;

    // First page
    const firstQ = lastDoc
      ? query(collection(db, 'timeEntries'), orderBy('workDate', 'desc'), startAfter(lastDoc), limit(PAGE_SIZE))
      : query(collection(db, 'timeEntries'), orderBy('workDate', 'desc'), limit(PAGE_SIZE));
    let snap = await getDocs(firstQ);
    all.push(...snap.docs.map(d => mapEntry(d.id, d.data())));

    // Subsequent pages until exhausted
    while (snap.size === PAGE_SIZE) {
      lastDoc = snap.docs[snap.docs.length - 1];
      const nextQ = query(
        collection(db, 'timeEntries'),
        orderBy('workDate', 'desc'),
        startAfter(lastDoc),
        limit(PAGE_SIZE),
      );
      snap = await getDocs(nextQ);
      if (snap.empty) break;
      all.push(...snap.docs.map(d => mapEntry(d.id, d.data())));
    }

    return all;
  }

  async getAllUsers(): Promise<User[]> {
    const snap = await getDocs(collection(db, 'users'));
    return snap.docs.map(d => {
      const data = d.data();
      return {
        uid: d.id,
        email: String(data.email || ''),
        name: String(data.name || ''),
        role: String(data.role || 'employee').toLowerCase() as User['role'],
        active: data.active !== false,
        work_email: data.work_email,
        phone_number: data.phone_number,
        sms_opt_in: !!data.sms_opt_in,
        timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        workModel: data.workModel === 'Remote' ? 'Remote' : 'On-site',
        workModelId: data.workModelId as string | undefined,
        workModelOverride: (data.workModelOverride as User['workModelOverride']) ?? null,
        remotePayCalculationDay: typeof data.remotePayCalculationDay === 'number' ? data.remotePayCalculationDay : undefined,
      };
    });
  }

  async updateUser(uid: string, updates: Partial<User>): Promise<User> {
    // stripUndefined is mandatory here: callers pass through profile fields
    // like work_email / phone_number that are frequently undefined, and
    // Firestore updateDoc throws "Unsupported field value: undefined" on any
    // undefined value — silently killing the entire save.
    await updateDoc(doc(db, 'users', uid), stripUndefined({
      ...updates,
      updatedAt: new Date(),
    }));
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) throw new Error('User not found');
    const data = snap.data() as DocumentData;
    return {
      uid: snap.id,
      email: String(data.email || ''),
      name: String(data.name || ''),
      role: String(data.role || 'employee').toLowerCase() as User['role'],
      active: data.active !== false,
      work_email: data.work_email,
      phone_number: data.phone_number,
      sms_opt_in: !!data.sms_opt_in,
      timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      workModel: data.workModel === 'Remote' ? 'Remote' : 'On-site',
      workModelId: data.workModelId as string | undefined,
      workModelOverride: (data.workModelOverride as User['workModelOverride']) ?? null,
      remotePayCalculationDay: typeof data.remotePayCalculationDay === 'number' ? data.remotePayCalculationDay : undefined,
    };
  }

  async deleteUserProfile(uid: string): Promise<void> {
    await deleteDoc(doc(db, 'users', uid));
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return null;
    const q = query(collection(db, 'users'), where('email', '==', normalizedEmail), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    const data = d.data() as DocumentData;
    return {
      uid: d.id,
      email: String(data.email || ''),
      name: String(data.name || ''),
      role: String(data.role || 'employee').toLowerCase() as User['role'],
      active: data.active !== false,
      work_email: data.work_email,
      phone_number: data.phone_number,
      sms_opt_in: !!data.sms_opt_in,
      timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      workModel: data.workModel === 'Remote' ? 'Remote' : 'On-site',
      workModelId: data.workModelId as string | undefined,
      workModelOverride: (data.workModelOverride as User['workModelOverride']) ?? null,
      remotePayCalculationDay: typeof data.remotePayCalculationDay === 'number' ? data.remotePayCalculationDay : undefined,
    };
  }

  /**
   * Segment-targeted direct edit (≤24h path, multi-shift safe). Updates a
   * single segment's manual time field in `segments[]` WITHOUT collapsing
   * other shifts (unlike directEditTimeField's replace mode). Recomputes the
   * edited segment's workMinutes (S6 cross-midnight-aware via
   * closeActiveSegment) and the day's totalWorkMinutes. If the edited segment
   * mirrors the top-level fields (is the current/last segment), the top-level
   * field is also updated so root and segments stay in sync.
   */
  async directEditSegmentField(args: {
    userId: string;
    actorName?: string;
    entryId: string;
    segmentId: string;
    field: 'clockInManual' | 'lunchOutManual' | 'lunchInManual' | 'clockOutManual';
    value: string;
    reason: string;
    /**
     * The employee's IANA timezone. Required to recompute the `*System` epoch
     * timestamps from the edited `*Manual` strings so the system instant (the
     * SSOT for display) stays in sync with the manual edit. When omitted, the
     * `*System` fields are left stale (pre-fix behaviour) — pass it from the
     * caller (the employee owns the entry, so the caller's tz is correct).
     */
    timezone?: string;
  }): Promise<TimeEntry> {
    const { userId, actorName, entryId, segmentId, field, value, reason, timezone } = args;
    const trimmedReason = (reason || '').trim();
    if (!trimmedReason) throw new Error('A reason is required to adjust a time.');

    const beforeSnap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!beforeSnap.exists()) throw new Error('Entry not found.');
    const before = mapEntry(entryId, beforeSnap.data());

    if (before.userId !== userId) {
      throw new Error('You can only edit your own time entries.');
    }

    // Find the target segment: in persisted segments[] or the synthesized current.
    const persistedSegs = before.segments ? before.segments.map((s) => ({ ...s })) : [];
    const currentSeg = before.currentSegment ?? null;

    let targetIdx = persistedSegs.findIndex((s) => s.id === segmentId);
    let targetSeg: TimeSegment | null = null;
    if (targetIdx >= 0) {
      targetSeg = persistedSegs[targetIdx];
    } else if (currentSeg && currentSeg.id === segmentId) {
      targetSeg = currentSeg;
    }
    if (!targetSeg) {
      throw new Error('Shift not found. It may have been modified.');
    }

    const beforeFieldVal = targetSeg[field] ?? null;

    // Anchor date for recomputing *System from the edited *Manual: prefer the
    // segment's attributed local date (set by the midnight splitter for
    // cross-midnight parts), else the entry's calendar date.
    const anchorDate = targetSeg.localDate ?? before.date ?? before.workDate;

    // Build the edited segment with the new manual value AND recomputed *System
    // epoch timestamps. Displays (Payroll rows, Team view) prefer *System as the
    // SSOT for instants, so leaving it stale after a manual edit made them show
    // the pre-edit time while the recomputed totals showed the edited value.
    // Recomputing all four boundaries (not just the edited one) handles the
    // case where editing clockIn flips the cross-midnight wrap for clockOut.
    const editedSeg = recomputeSegmentSystemTimestamps(
      { ...targetSeg, [field]: value },
      anchorDate,
      timezone,
    );

    // Rebuild the segments array — update the target in-place if persisted,
    // or update the matching open segment if the target was the synthesized current.
    let newSegments: TimeSegment[];
    if (targetIdx >= 0) {
      newSegments = persistedSegs.map((s, i) => (i === targetIdx ? editedSeg : s));
    } else {
      // The current segment — may be dual-written as an open segment in segments[].
      const openIdx = persistedSegs.findIndex((s) => !s.complete);
      if (openIdx >= 0) {
        newSegments = persistedSegs.map((s, i) =>
          (i === openIdx ? recomputeSegmentSystemTimestamps({ ...s, [field]: value }, anchorDate, timezone) : s),
        );
      } else {
        newSegments = [...persistedSegs, editedSeg];
      }
    }

    // SSOT: recompute every complete segment's workMinutes + the day
    // totalWorkMinutes/totalHours via the single canonical writer, so the
    // persisted top-level fields stay in lock-step with the edited manual
    // punch times (no stale totalWorkMinutes/totalHours after an edit).
    const recalc = recalculateEntryTotals(newSegments);
    newSegments = recalc.segments;
    const totalWorkMinutes = recalc.totalWorkMinutes;

    // Update top-level field if the target mirrors it (current segment or
    // last persisted segment whose clockIn matches the root).
    const isCurrent = currentSeg && segmentId === currentSeg.id;
    const isLastMirroring =
      targetIdx >= 0 &&
      targetIdx === persistedSegs.length - 1 &&
      before.clockInManual === targetSeg.clockInManual;
    const updateTopLevel = isCurrent || isLastMirroring;

    const patch: Record<string, unknown> = {
      segments: newSegments.map((s) => stripUndefined(s)),
      totalWorkMinutes,
      totalHours: recalc.totalHours,
      status: 'corrected',
      updatedAt: Timestamp.now(),
      updatedBy: userId,
    };
    if (updateTopLevel) {
      patch[field] = value;
      // Sync the matching top-level *System epoch too, so root and segment
      // stay in lock-step (the root *System is read by Team view / mapEntry).
      // Write BOTH the millis and the Firestore Timestamp: mapEntry's top-level
      // read prefers *SystemTime, so without it the stale pre-edit Timestamp
      // would shadow the recomputed millis.
      const sysField = fieldToSystemField(field);
      if (sysField) {
        const sysVal = editedSeg[sysField];
        if (typeof sysVal === 'number') {
          patch[sysField] = sysVal;
          patch[`${sysField}Time`] = Timestamp.fromMillis(sysVal);
        }
      }
    }

    // --- Adjustment guardrails (2026-08) -------------------------------
    // Chronology (cross-midnight aware) on the edited segment; future-time
    // rejection on its recomputed epochs; no overlap with sibling shifts;
    // payroll-lock check. All run BEFORE the audit write so a rejected edit
    // produces no audit row.
    const editChronologyErrors = validateSegmentChronology(editedSeg, {
      allowOpen: !editedSeg.clockOutManual,
    });
    if (editChronologyErrors.length) throw new Error(editChronologyErrors[0]);
    const editFutureError = getFuturePunchError(editedSeg, Date.now());
    if (editFutureError) throw new Error(editFutureError);
    const editOverlapError = getSegmentOverlapError(newSegments);
    if (editOverlapError) throw new Error(editOverlapError);
    await this.assertPayrollDatesNotLocked(anchorDate, before.date ?? before.workDate);

    // 1) Audit FIRST (mandatory, non-bypassable).
    await auditLogService.logTimeCorrection({
      actorUid: userId,
      actorName,
      actorRole: 'employee',
      targetId: entryId,
      before: { segmentId, [field]: beforeFieldVal, totalWorkMinutes: before.totalWorkMinutes },
      after: { segmentId, [field]: value, totalWorkMinutes },
      reason: trimmedReason,
    });

    // 2) Mutate time record.
    await updateDoc(doc(db, 'timeEntries', entryId), patch);

    // Re-read + return hydrated view.
    const freshSnap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!freshSnap.exists()) throw new Error('Entry not found after update.');
    return mapEntry(entryId, freshSnap.data());
  }

  /**
   * Retroactive direct shift close (≤24h path). Closes an OPEN segment by
   * setting its clock-out, computing workMinutes (S6 cross-midnight-aware via
   * closeActiveSegment), setting the day-completion flags, and recomputing
   * the day total. Writes the mandatory audit log FIRST (employee self-audit),
   * then mutates timeEntries.
   *
   * The 24h threshold is checked by the caller (TimeAdjustmentModal) using the
   * segment's clockInSystem — this method performs the close once invoked.
   */
  async directCloseShift(args: {
    userId: string;
    actorName?: string;
    entryId: string;
    segmentId: string;
    clockOut: string; // HH:MM
    reason: string;
    /**
     * The employee's IANA timezone. Used to derive the `clockOutSystem` epoch
     * from the manually-entered `clockOut` HH:MM (the SSOT for instants) so a
     * retroactive close shows the entered time, not "now". Falls back to the
     * current instant when omitted (pre-fix behaviour).
     */
    timezone?: string;
  }): Promise<TimeEntry> {
    const { userId, actorName, entryId, segmentId, clockOut, reason, timezone } = args;
    const trimmedReason = (reason || '').trim();
    if (!trimmedReason) throw new Error('A reason is required to close a shift.');

    const beforeSnap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!beforeSnap.exists()) throw new Error('Entry not found.');
    const before = mapEntry(entryId, beforeSnap.data());

    if (before.userId !== userId) {
      throw new Error('You can only edit your own time entries.');
    }

    // Find the target segment.
    const persistedSegs = before.segments ? before.segments.map((s) => ({ ...s })) : [];
    const currentSeg = before.currentSegment ?? null;

    let targetIdx = persistedSegs.findIndex((s) => s.id === segmentId);
    let targetSeg: TimeSegment | null = null;
    if (targetIdx >= 0) {
      targetSeg = persistedSegs[targetIdx];
    } else if (currentSeg && currentSeg.id === segmentId) {
      targetSeg = currentSeg;
    }
    if (!targetSeg) throw new Error('Shift not found. It may have been modified.');

    // Guard on the actual clock-out value, not the `complete` flag. A doc may
    // carry a stale/contradictory `complete` flag while still lacking a
    // clock-out (the case TimeAdjustmentModal's retroactive-close entry
    // explicitly handles). `closeActiveSegment` always sets `clockOutManual`
    // when it closes a segment, so a truthy value here reliably means the
    // shift was genuinely closed — and a stale-flagged-but-clock-out-less
    // segment can be closed without a confusing late rejection.
    if (targetSeg.clockOutManual) throw new Error('This shift is already closed.');
    if (!targetSeg.clockInManual) throw new Error('Cannot close a shift without a clock-in time.');

    // Chronology (cross-midnight aware) on the would-be closed segment —
    // subsumes the old clockOut > clockIn wrap check and adds lunch bounds.
    const closeErrors = validateSegmentChronology(
      { ...targetSeg, clockOutManual: clockOut },
      { allowOpen: false },
    );
    if (closeErrors.length) throw new Error(closeErrors[0]);

    const beforeFieldVal = targetSeg.clockOutManual ?? null;
    const now = Timestamp.now();

    // Derive the clock-out epoch from the manually-entered HH:MM (the actual
    // clock-out instant) instead of "now". Displays prefer clockOutSystem as
    // the SSOT, so a retroactive close must persist the entered time — not the
    // moment the employee clicked the button — or the Payroll/Team rows would
    // show "now" while the total (from the manual) showed the entered span.
    // Cross-midnight aware (wrap relative to the segment's clockIn).
    const anchorDate = targetSeg.localDate ?? before.date ?? before.workDate;
    const clockOutSystem =
      epochFromLocalWallTime(clockOut, anchorDate, timezone, targetSeg.clockInManual) ?? now.toMillis();

    // Close the segment via the canonical helper (S6 wrap + lunch deduction).
    const closedSeg = closeActiveSegment(
      targetSeg,
      clockOut,
      clockOutSystem,
      targetSeg.skipLunch ?? false,
    );

    // Rebuild segments — update the target in-place if persisted, or update
    // the matching open segment if the target was the synthesized current.
    let newSegments: TimeSegment[];
    if (targetIdx >= 0) {
      newSegments = persistedSegs.map((s, i) => (i === targetIdx ? closedSeg : s));
    } else {
      const openIdx = persistedSegs.findIndex((s) => !s.complete);
      if (openIdx >= 0) {
        newSegments = persistedSegs.map((s, i) => (i === openIdx ? closedSeg : s));
      } else {
        newSegments = [...persistedSegs, closedSeg];
      }
    }

    // Recompute day total from all complete segments.
    const totalWorkMinutes = newSegments.reduce(
      (sum, s) => sum + (s.complete ? s.workMinutes || 0 : 0),
      0,
    );

    // Future-time + overlap + payroll-lock guardrails (all pre-audit).
    const closeFutureError = getFuturePunchError(closedSeg, Date.now());
    if (closeFutureError) throw new Error(closeFutureError);
    const closeOverlapError = getSegmentOverlapError(newSegments);
    if (closeOverlapError) throw new Error(closeOverlapError);
    await this.assertPayrollDatesNotLocked(anchorDate, before.date ?? before.workDate);

    // 1) Audit FIRST (mandatory, non-bypassable). Employee self-audit.
    await auditLogService.logTimeCorrection({
      actorUid: userId,
      actorName,
      actorRole: 'employee',
      action: 'time_correction',
      targetId: entryId,
      before: { clockOutManual: beforeFieldVal, totalWorkMinutes: before.totalWorkMinutes, status: before.status },
      after: { clockOutManual: clockOut, totalWorkMinutes, status: 'corrected' },
      reason: trimmedReason,
    });

    // 2) Mutate the timeEntries doc — close the shift + set completion flags.
    await updateDoc(doc(db, 'timeEntries', entryId), {
      clockOutManual: clockOut,
      clockOutSystem,
      clockOutSystemTime: Timestamp.fromMillis(clockOutSystem),
      segments: newSegments.map((s) => stripUndefined(s)),
      totalWorkMinutes,
      totalHours: totalWorkMinutes / 60,
      complete: true,
      dayComplete: true,
      currentStep: 4,
      completedAt: now.toMillis(),
      status: 'corrected',
      updatedAt: now,
      updatedBy: userId,
    });

    // Re-read + return hydrated view.
    const freshSnap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!freshSnap.exists()) throw new Error('Entry not found after update.');
    return mapEntry(entryId, freshSnap.data());
  }

  /**
   * Retroactive direct lunch-end (≤24h path). Ends an in-progress lunch on an
   * OPEN segment by setting lunchIn + lunchInSystem, WITHOUT closing the shift
   * (the employee continues working). Validates lunchIn > lunchOut (S6
   * cross-midnight-aware). Writes the mandatory audit log FIRST (employee
   * self-audit), then mutates timeEntries.
   *
   * The 24h threshold is checked by the caller (TimeAdjustmentModal) using the
   * segment's lunchOutSystem — this method performs the end-lunch once invoked.
   */
  async directEndLunch(args: {
    userId: string;
    actorName?: string;
    entryId: string;
    segmentId: string;
    lunchIn: string; // HH:MM
    reason: string;
    /**
     * The employee's IANA timezone. Used to derive `lunchInSystem` from the
     * manually-entered `lunchIn` HH:MM so a retroactive lunch-end shows the
     * entered time, not "now". Falls back to the current instant when omitted.
     */
    timezone?: string;
  }): Promise<TimeEntry> {
    const { userId, actorName, entryId, segmentId, lunchIn, reason, timezone } = args;
    const trimmedReason = (reason || '').trim();
    if (!trimmedReason) throw new Error('A reason is required to end lunch.');

    const beforeSnap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!beforeSnap.exists()) throw new Error('Entry not found.');
    const before = mapEntry(entryId, beforeSnap.data());

    if (before.userId !== userId) {
      throw new Error('You can only edit your own time entries.');
    }

    // Find the target segment.
    const persistedSegs = before.segments ? before.segments.map((s) => ({ ...s })) : [];
    const currentSeg = before.currentSegment ?? null;

    let targetIdx = persistedSegs.findIndex((s) => s.id === segmentId);
    let targetSeg: TimeSegment | null = null;
    if (targetIdx >= 0) {
      targetSeg = persistedSegs[targetIdx];
    } else if (currentSeg && currentSeg.id === segmentId) {
      targetSeg = currentSeg;
    }
    if (!targetSeg) throw new Error('Shift not found. It may have been modified.');

    if (targetSeg.complete) throw new Error('Cannot end lunch on a closed shift.');
    if (!targetSeg.lunchOutManual) throw new Error('No lunch break was started on this shift.');
    if (targetSeg.lunchInManual) throw new Error('Lunch has already ended on this shift.');

    // Chronology (cross-midnight aware) with the lunch ended — subsumes
    // the old lunchIn > lunchOut wrap check. The shift stays open, so
    // allowOpen permits the still-missing clock-out.
    const lunchErrors = validateSegmentChronology(
      { ...targetSeg, lunchInManual: lunchIn },
      { allowOpen: true },
    );
    if (lunchErrors.length) throw new Error(lunchErrors[0]);

    const beforeFieldVal = targetSeg.lunchInManual ?? null;
    const now = Timestamp.now();

    // Derive the lunch-in epoch from the manually-entered HH:MM (the actual
    // lunch-end instant) instead of "now". Cross-midnight aware (wrap relative
    // to the segment's clockIn) so a lunch that ends after midnight lands on
    // the correct day.
    const anchorDate = targetSeg.localDate ?? before.date ?? before.workDate;
    const lunchInSystem =
      epochFromLocalWallTime(lunchIn, anchorDate, timezone, targetSeg.clockInManual) ?? now.toMillis();

    // Update the segment with lunchIn + system timestamp. Segment stays OPEN.
    const updatedSeg: TimeSegment = {
      ...targetSeg,
      lunchInManual: lunchIn,
      lunchInSystem,
      complete: false,
    };

    // Rebuild segments — update the target in-place.
    let newSegments: TimeSegment[];
    if (targetIdx >= 0) {
      newSegments = persistedSegs.map((s, i) => (i === targetIdx ? updatedSeg : s));
    } else {
      const openIdx = persistedSegs.findIndex((s) => !s.complete);
      if (openIdx >= 0) {
        newSegments = persistedSegs.map((s, i) => (i === openIdx ? updatedSeg : s));
      } else {
        newSegments = [...persistedSegs, updatedSeg];
      }
    }

    // Determine if the top-level field should be synced (current segment or
    // last-mirroring segment, same logic as directEditSegmentField).
    const isCurrent = currentSeg && segmentId === currentSeg.id;
    const isLastMirroring =
      targetIdx >= 0 &&
      targetIdx === persistedSegs.length - 1 &&
      before.clockInManual === targetSeg.clockInManual;
    const updateTopLevel = isCurrent || isLastMirroring;

    // Future-time + payroll-lock guardrails (pre-audit). The shift span is
    // unchanged (lunch only), so no overlap check is needed here.
    const endLunchFutureError = getFuturePunchError(updatedSeg, Date.now());
    if (endLunchFutureError) throw new Error(endLunchFutureError);
    await this.assertPayrollDatesNotLocked(anchorDate, before.date ?? before.workDate);

    // 1) Audit FIRST (mandatory, non-bypassable). Employee self-audit.
    await auditLogService.logTimeCorrection({
      actorUid: userId,
      actorName,
      actorRole: 'employee',
      action: 'time_correction',
      targetId: entryId,
      before: { lunchInManual: beforeFieldVal, totalWorkMinutes: before.totalWorkMinutes, status: before.status },
      after: { lunchInManual: lunchIn, totalWorkMinutes: before.totalWorkMinutes, status: 'corrected' },
      reason: trimmedReason,
    });

    // 2) Mutate the timeEntries doc. The shift stays open (no completion
    //    flags); only the lunch-in field + segment are updated.
    const patch: Record<string, unknown> = {
      segments: newSegments.map((s) => stripUndefined(s)),
      status: 'corrected',
      updatedAt: now,
      updatedBy: userId,
    };
    if (updateTopLevel) {
      patch.lunchInManual = lunchIn;
      patch.lunchInSystemTime = Timestamp.fromMillis(lunchInSystem);
      patch.lunchInSystem = lunchInSystem;
    }
    await updateDoc(doc(db, 'timeEntries', entryId), patch);

    // Re-read + return hydrated view.
    const freshSnap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!freshSnap.exists()) throw new Error('Entry not found after update.');
    return mapEntry(entryId, freshSnap.data());
  }

  /** Active (un-resolved) correction requests for a user — for badge display. */
  async getActiveCorrectionRequestsForUser(userId: string): Promise<CorrectionRequest[]> {
    const all = await this.getCorrectionRequestsForUser(userId);
    const active: CorrectionRequest['status'][] = ['Open', 'In Progress'];
    return all.filter((r) => active.includes(r.status));
  }

  // ---- Correction Requests ----

  async createCorrectionRequest(data: Omit<CorrectionRequest, 'id'>): Promise<string> {
    // Payroll-lock guardrail: no new correction requests for locked periods.
    await this.assertPayrollNotLocked(data.requested_date);
    // Sanitize: Firestore addDoc() rejects `undefined` field values. Optional
    // fields (requested_lunch, suggested_time, original_*, resolution_note,
    // updated_by, etc.) arrive as `undefined` when the caller omits them — e.g.
    // a non-lunch Clock Out request leaves `requested_lunch: undefined`, which
    // throws "Unsupported field value: undefined". Strip all undefined keys
    // before write so any correction request saves cleanly.
    const payload: Record<string, unknown> = { ...data, created_at: Timestamp.now() };
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) delete payload[key];
    }
    const docRef = await addDoc(collection(db, 'correctionRequests'), payload);
    return docRef.id;
  }

  async getCorrectionRequestsForUser(userId: string): Promise<CorrectionRequest[]> {
    const q = query(
      collection(db, 'correctionRequests'),
      where('employee_id', '==', userId),
      orderBy('created_at', 'desc')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        employee_id: data.employee_id,
        employee_name: data.employee_name || '',
        requested_date: data.requested_date,
        issue_type: data.issue_type,
        notes: data.notes,
        suggested_time: data.suggested_time || undefined,
        original_clock_in: data.original_clock_in || undefined,
        original_clock_out: data.original_clock_out || undefined,
        original_lunch: data.original_lunch || undefined,
        requested_clock_in: data.requested_clock_in || undefined,
        requested_clock_out: data.requested_clock_out || undefined,
        requested_lunch: data.requested_lunch || undefined,
        status: data.status || 'Open',
        resolution_note: data.resolution_note || undefined,
        rejection_reason: data.rejection_reason || undefined,
        created_at: tsToMillis(data.created_at) || Date.now(),
        updated_at: tsToMillis(data.updated_at) || undefined,
        updated_by: data.updated_by || undefined,
      } as CorrectionRequest;
    });
  }

  async getAllCorrectionRequests(): Promise<CorrectionRequest[]> {
    const q = query(
      collection(db, 'correctionRequests'),
      orderBy('created_at', 'desc'),
      limit(500)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        employee_id: data.employee_id,
        employee_name: data.employee_name || '',
        requested_date: data.requested_date,
        issue_type: data.issue_type,
        notes: data.notes,
        suggested_time: data.suggested_time || undefined,
        original_clock_in: data.original_clock_in || undefined,
        original_clock_out: data.original_clock_out || undefined,
        original_lunch: data.original_lunch || undefined,
        requested_clock_in: data.requested_clock_in || undefined,
        requested_clock_out: data.requested_clock_out || undefined,
        requested_lunch: data.requested_lunch || undefined,
        status: data.status || 'Open',
        resolution_note: data.resolution_note || undefined,
        rejection_reason: data.rejection_reason || undefined,
        created_at: tsToMillis(data.created_at) || Date.now(),
        updated_at: tsToMillis(data.updated_at) || undefined,
        updated_by: data.updated_by || undefined,
      } as CorrectionRequest;
    });
  }

  /**
   * Resolve a correction request AND apply the time change.
   *
   * When status === 'Resolved': maps issue_type to the target timeEntries
   * field, updates the matching segment via buildConsistentClosePatch (S7
   * dual-write + S6 cross-midnight), recomputes totalWorkMinutes, writes the
   * mandatory auditLogs entry (action 'admin_correction_approved') FIRST, then
   * mutates timeEntries, then finally marks the correctionRequests doc as
   * Resolved.
   *
   * Ordering & failure semantics (NOT a Firestore transaction — auditLogs is
   * append-only/immutable so it cannot be rolled back):
   *  - Audit is written FIRST as a durable precondition. This is intentional:
   *    the mandatory-audit guardrail (AGENTS.md / .kilo/rules) prioritizes
   *    "never change a time record without an audit entry existing" over
   *    "never have an audit entry without a time change." An orphaned audit
   *    (audit exists, time write failed) is the SAFE failure mode — it records
   *    that an admin attempted this correction, and the request stays
   *    un-Resolved so the admin sees the error and can retry.
   *  - If the timeEntries write (step 7) succeeds but the correctionRequests
   *    status write (step 8) fails, the time change persists and the request
   *    stays un-Resolved. The admin can retry or manually mark it Resolved.
   *    This is preferable to a transaction that would roll back the time
   *    change on a transient request-status write failure.
   *
   * For 'In Progress' / 'Rejected' (non-Resolved) statuses, only the
   * correctionRequests doc is updated (no time-entry mutation).
   */
  async resolveCorrectionRequest(args: {
    requestId: string;
    adminUid: string;
    adminName?: string;
    newStatus: CorrectionRequest['status'];
    resolutionNote: string;
  }): Promise<void> {
    const { requestId, adminUid, adminName, newStatus, resolutionNote } = args;
    // Resolution note is optional (the UI no longer collects one). It is NOT
    // validated as non-empty here. The mandatory-audit-reason rule requires a
    // HUMAN-PROVIDED reason on every correction: when the admin note is empty,
    // the audit reason below embeds the employee's own request notes (required
    // at submission) instead of a machine-generated default string.
    const trimmedNote = (resolutionNote || '').trim();

    // 1) Read the correction request to get the target field + suggested time.
    const reqSnap = await getDoc(doc(db, 'correctionRequests', requestId));
    if (!reqSnap.exists()) throw new Error('Correction request not found.');
    const reqData = reqSnap.data();
    const request = {
      id: requestId,
      employee_id: reqData.employee_id,
      requested_date: reqData.requested_date,
      issue_type: reqData.issue_type,
      suggested_time: reqData.suggested_time || undefined,
      requested_clock_in: reqData.requested_clock_in || undefined,
      requested_clock_out: reqData.requested_clock_out || undefined,
      requested_lunch: reqData.requested_lunch || undefined,
      notes: reqData.notes || '',
      status: reqData.status || 'Open',
    };

    // 2) If not Resolved, just update the request doc (no time-entry mutation).
    if (newStatus !== 'Resolved') {
      const patch: Record<string, unknown> = {
        status: newStatus,
        updated_at: Timestamp.now(),
        updated_by: adminUid,
      };
      if (newStatus === 'Rejected') {
        patch.rejection_reason = trimmedNote;
      } else {
        patch.resolution_note = trimmedNote;
      }
      await updateDoc(doc(db, 'correctionRequests', requestId), patch);
      return;
    }

    // 3) Resolved: apply the time change. Map issue_type → field + value.
    const entryId = `${request.employee_id}_${request.requested_date}`;
    const issueTypeToField: Record<string, 'clockInManual' | 'lunchOutManual' | 'lunchInManual' | 'clockOutManual'> = {
      'Clock In': 'clockInManual',
      'Lunch Out': 'lunchOutManual',
      'Lunch In': 'lunchInManual',
      'Clock Out': 'clockOutManual',
    };
    const field = issueTypeToField[request.issue_type];
    if (!field) {
      throw new Error(`Cannot apply change for issue type "${request.issue_type}". Update the time entry manually.`);
    }
    // Resolve the suggested value: prefer suggested_time, fall back to the
    // requested_* field matching the issue_type.
    let value: string | undefined = request.suggested_time;
    if (!value) {
      if (field === 'clockInManual') value = request.requested_clock_in;
      else if (field === 'clockOutManual') value = request.requested_clock_out;
      else if (field === 'lunchOutManual' || field === 'lunchInManual') {
        // requested_lunch may be "HH:MM - HH:MM" or a single time.
        if (request.requested_lunch) {
          const parts = request.requested_lunch.split('-').map((s: string) => s.trim());
          value = field === 'lunchOutManual' ? parts[0] : parts[1] || parts[0];
        }
      }
    }
    if (!value) {
      throw new Error('No suggested/requested time found in the correction request.');
    }

    // 4) Read the target timeEntries doc.
    const beforeSnap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!beforeSnap.exists()) {
      throw new Error(`Time entry not found for ${request.employee_id} on ${request.requested_date}. Create it first or update manually.`);
    }
    const before = mapEntry(entryId, beforeSnap.data());
    const beforeFieldVal = before[field] ?? null;

    // 5) Locate the target shift and apply the correction IN-PLACE. A correction
    // request updates an EXISTING shift's boundary — it must never append a new
    // segment or split the shift. (The previous buildConsistentClosePatch('append')
    // approach created a duplicate "Shift 2" and stamped cross-midnight epochs
    // that inflated its Payroll duration.)
    const after: TimeEntry = { ...before, [field]: value };
    const hasClockOut = !!after.clockOutManual;

    // Resolve the employee's canonical timezone (user.timezone, OS fallback) so
    // the requested HH:MM is interpreted in the correct local zone.
    const empUserSnap = await getDoc(doc(db, 'users', request.employee_id));
    const empTz = getEmployeeTimezone(empUserSnap.exists() ? (empUserSnap.data().timezone as string | undefined) : undefined);

    const persistedSegs = before.segments ? before.segments.map((s) => ({ ...s })) : [];
    const currentSeg = before.currentSegment ?? null;

    // Target the shift the root legacy fields mirror (the current / most-recent
    // shift). Prefer the persisted segment whose clockIn matches the root
    // clockIn (same shift, dual-write); fall back to the last persisted
    // segment; else the synthesized current view (legacy doc with no segments).
    let targetIdx = before.clockInManual
      ? persistedSegs.findIndex((s) => s.clockInManual === before.clockInManual)
      : -1;
    if (targetIdx < 0 && persistedSegs.length > 0) targetIdx = persistedSegs.length - 1;
    const targetBase = targetIdx >= 0 ? persistedSegs[targetIdx] : currentSeg;
    if (!targetBase) throw new Error('No shift found to correct on this entry.');
    const anchorDate = targetBase.localDate ?? before.date ?? before.workDate;

    // Apply the single-field correction IN-PLACE and recompute ALL four *System
    // epochs from the corrected manual times on the shift's local calendar date
    // (cross-midnight wrap-aware: an evening time like 16:00 stays on the same
    // date — no next-day epoch rollover). This keeps Payroll rows / Team view
    // (which prefer *System) in lock-step with the corrected manual times.
    let segments: TimeSegment[];
    let editedSeg: TimeSegment;
    if (targetIdx >= 0) {
      editedSeg = recomputeSegmentSystemTimestamps({ ...persistedSegs[targetIdx], [field]: value }, anchorDate, empTz);
      segments = persistedSegs.map((s, i) => (i === targetIdx ? editedSeg : s));
    } else {
      // Legacy doc (no persisted segments[]): persist the corrected current view
      // as the single (first) segment — not a duplicate.
      editedSeg = recomputeSegmentSystemTimestamps(
        { ...currentSeg, id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`, [field]: value },
        anchorDate,
        empTz,
      );
      segments = [editedSeg];
    }

    // --- Adjustment guardrails (2026-08, pre-audit) -----------------------
    // The applied value must not invert the shift's chronology (cross-midnight
    // aware), land in the future, overlap a sibling shift, or touch a locked
    // payroll period — the admin approval alone does not check these.
    const reqChronologyErrors = validateSegmentChronology(editedSeg, {
      allowOpen: !editedSeg.clockOutManual,
    });
    if (reqChronologyErrors.length) throw new Error(reqChronologyErrors[0]);
    const reqFutureError = getFuturePunchError(editedSeg, Date.now());
    if (reqFutureError) throw new Error(reqFutureError);
    const reqOverlapError = getSegmentOverlapError(segments);
    if (reqOverlapError) throw new Error(reqOverlapError);
    await this.assertPayrollDatesNotLocked(anchorDate, request.requested_date);

    // SSOT: recompute every complete segment's workMinutes + the day totals from
    // the corrected timestamps, so stored totalWorkMinutes/totalHours exactly
    // match the edited span (e.g. 16:00→16:45 = 45 min = 0.75 h, no drift).
    const recalc = recalculateEntryTotals(segments);
    segments = recalc.segments;
    after.totalWorkMinutes = recalc.totalWorkMinutes;
    after.totalHours = recalc.totalHours;
    const sysSeg = recalc.segments.find((s) => s.id === editedSeg.id) ?? editedSeg;

    // 6) Audit FIRST (mandatory, non-bypassable). Admin action.
    await auditLogService.logTimeCorrection({
      actorUid: adminUid,
      actorName: adminName,
      actorRole: 'admin',
      action: 'admin_correction_approved',
      targetId: entryId,
      before: { field, [field]: beforeFieldVal, totalWorkMinutes: before.totalWorkMinutes },
      after: { field, [field]: value, totalWorkMinutes: after.totalWorkMinutes },
      reason: trimmedNote
        ? `${trimmedNote} (approved correction request ${requestId} for ${request.issue_type})`
        : `Approved correction request ${requestId} for ${request.issue_type}: "${request.notes}"`,
      correctionRequestId: requestId,
    });

    // 7) Mutate the timeEntries doc. When the edit closes a shift (clock-out
    // present), set the day-completion flags so mapEntry (which derives
    // completeness from dayComplete) renders the entry as Complete — without
    // these, an admin-approved clock-out would still show as "Incomplete/Open".
    // Write the corrected top-level *System epochs (millis + Timestamp) from the
    // recomputed segment so root and segment stay in lock-step and Team view /
    // mapEntry (which read the top-level *SystemTime) show the corrected
    // instants. Lunch *System is guarded by skipLunch (the closed segment has no
    // lunch fields when the shift skips lunch).
    const sysPatch: Record<string, unknown> = sysSeg
      ? stripUndefined({
          clockInSystem: sysSeg.clockInSystem,
          clockOutSystem: sysSeg.clockOutSystem,
          lunchOutSystem: after.skipLunch ? undefined : sysSeg.lunchOutSystem,
          lunchInSystem: after.skipLunch ? undefined : sysSeg.lunchInSystem,
          clockInSystemTime: sysSeg.clockInSystem != null ? Timestamp.fromMillis(sysSeg.clockInSystem) : undefined,
          clockOutSystemTime: sysSeg.clockOutSystem != null ? Timestamp.fromMillis(sysSeg.clockOutSystem) : undefined,
          lunchOutSystemTime: after.skipLunch || sysSeg.lunchOutSystem == null ? undefined : Timestamp.fromMillis(sysSeg.lunchOutSystem),
          lunchInSystemTime: after.skipLunch || sysSeg.lunchInSystem == null ? undefined : Timestamp.fromMillis(sysSeg.lunchInSystem),
        })
      : {};
    await updateDoc(doc(db, 'timeEntries', entryId), {
      [field]: value,
      segments: segments.map((s) => stripUndefined(s)),
      ...sysPatch,
      ...(hasClockOut
        ? {
            totalWorkMinutes: after.totalWorkMinutes,
            totalHours: after.totalHours,
            complete: true,
            dayComplete: true,
            currentStep: 4,
            completedAt: Date.now(),
          }
        : {}),
      status: 'corrected',
      updatedAt: Timestamp.now(),
      updatedBy: adminUid,
    });

    // 8) Only after timeEntries is updated, mark the correction request Resolved.
    await updateDoc(doc(db, 'correctionRequests', requestId), {
      status: 'Resolved',
      resolution_note: trimmedNote,
      updated_at: Timestamp.now(),
      updated_by: adminUid,
    });
  }

  async updateCorrectionRequest(id: string, updates: Partial<CorrectionRequest>): Promise<void> {
    const patch: Record<string, unknown> = { updated_at: Timestamp.now() };
    if (updates.status !== undefined) patch.status = updates.status;
    if (updates.resolution_note !== undefined) patch.resolution_note = updates.resolution_note;
    if (updates.rejection_reason !== undefined) patch.rejection_reason = updates.rejection_reason;
    if (updates.updated_by !== undefined) patch.updated_by = updates.updated_by;
    await updateDoc(doc(db, 'correctionRequests', id), patch);
  }

  /**
   * Update a shift doc's `dailyReport` note (Remote employees, Edit Daily
   * Reports modal). Unlike punchOut — which writes the note at the real
   * close-shift instant — this edits a HISTORICAL day doc, so it follows the
   * sanctioned correction path: payroll-lock guardrail + immutable audit row
   * FIRST, then the mutation. No correction request ticket is created (the
   * note is not pay-affecting), but the change is still audit-logged per the
   * AGENTS.md audit requirement for edits to time records.
   */
  async updateDailyReport(entryId: string, value: string, actor: User): Promise<TimeEntry> {
    const snap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!snap.exists()) throw new Error('Entry not found.');
    const before = mapEntry(entryId, snap.data());
    const beforeVal = before.dailyReport ?? '';
    const nextVal = (value ?? '').slice(0, 250);

    // Payroll-lock guardrail (pre-audit), same as every other edit path.
    await this.assertPayrollDatesNotLocked(before.date ?? before.workDate);

    // 1) Audit FIRST (mandatory, non-bypassable). The reason documents the
    //    action itself; the note content lives in the before/after snapshots.
    await auditLogService.logTimeCorrection({
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: 'employee',
      action: 'time_correction',
      targetId: entryId,
      before: { dailyReport: beforeVal },
      after: { dailyReport: nextVal },
      reason: 'Daily report note updated',
    });

    // 2) Mutate the timeEntries doc.
    await updateDoc(doc(db, 'timeEntries', entryId), {
      dailyReport: nextVal,
      updatedAt: Timestamp.now(),
      updatedBy: actor.uid,
    });

    // Re-read + return hydrated view.
    const freshSnap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!freshSnap.exists()) throw new Error('Entry not found after update.');
    return mapEntry(entryId, freshSnap.data());
  }

  /**
   * Lock-check EVERY calendar date an adjustment touches. The owning doc's
   * date and the edited segment's attributed local date can differ across a
   * local-midnight split (targetSeg.localDate may be the next day while
   * before.date is the doc's day) — checking only the doc date would let the
   * locked-period guardrail be bypassed on exactly those cross-midnight
   * entries.
   */
  async assertPayrollDatesNotLocked(...dates: (string | undefined)[]): Promise<void> {
    for (const d of new Set(dates.filter((x): x is string => !!x))) {
      await this.assertPayrollNotLocked(d);
    }
  }

  /**
   * Payroll-lock guardrail (2026-08): reject any correction / adjustment to an
   * entry whose work date falls inside a locked payroll period
   * (systemSettings/global.locked_up_to_date, PT date string, inclusive).
   * Throws with a human-readable message; callers surface it as a toast.
   * No-op when no lock date is set or the entry has no resolvable date.
   */
  async assertPayrollNotLocked(workDate: string | undefined): Promise<void> {
    if (!workDate) return;
    const settings = await this.getPayrollSettings();
    const lockedUpTo = ((settings?.locked_up_to_date as string) || '').trim();
    if (lockedUpTo && workDate <= lockedUpTo) {
      throw new Error(
        `This date (${workDate}) is in a locked payroll period (locked through ${lockedUpTo}). Ask an administrator to unlock the period first.`,
      );
    }
  }

  async getPayrollSettings(): Promise<DocumentData | null> {
    // Read-through fallback: honors systemSettings/global, falling back to the
    // legacy reminders/payroll docs when global isn't migrated yet, so the
    // payroll lock date keeps taking effect during the migration window.
    return fetchGlobalSettings();
  }

  async setPayrollLock(dateStr: string, adminId: string): Promise<void> {
    await setDoc(doc(db, 'systemSettings', 'global'), {
      locked_up_to_date: dateStr,
      payroll_entries_locked_at: Timestamp.now(),
      payroll_entries_locked_by: adminId,
      updatedAt: Timestamp.now(),
      updatedBy: adminId,
    }, { merge: true });
  }
}

export const dbService = new DatabaseService();