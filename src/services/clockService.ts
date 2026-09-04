import {
  doc,
  runTransaction,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import type { DocumentData } from 'firebase/firestore';
import { db } from '../app/lib/firebase';
import type { TimeEntry, TimeSegment } from '../app/lib/database';
import {
  dbService,
  getActiveSegment,
  createInitialSegment,
  closeActiveSegment,
  applyLunchToSegment,
  stripUndefined,
  computeSegmentWorkMinutes,
} from '../app/lib/database';
import {
  getCurrentPTDate,
  getCurrentPTTimeHHMM,
  getPTWeekStart,
  getPTDate,
  getLocalDate,
  getLocalTimeHHMM,
  subtractLocalDays,
} from '../utils/timeCalculations';
import {
  validateCanPunchIn,
  validateCanPunchOut,
  validateCanToggleLunch,
} from '../utils/timeValidation';
import {
  splitSegmentAcrossMidnights,
  localDateOf,
  type SplitSegmentShape,
} from '../utils/midnightSplit';
import { explodeDocsBySegmentLocalDate } from '../utils/timeView';

/**
 * ClockService — owned by Clock Agent (Phase 1)
 *
 * Thin, atomic wrapper around the TimeSegment model for employee punch flows.
 * - Enforces "exactly one open segment per employee per workDate"
 * - Uses Firestore transaction on punchIn for double-tap safety across tabs/devices
 * - Work date + manual wall-clock times are written in the EMPLOYEE'S LOCAL
 *   timezone when a `timezone` is supplied (the local-time-tracking refactor),
 *   and fall back to America/Los_Angeles when omitted (legacy callers/tests).
 * - Dual-writes legacy flat fields + segments[] for full backward compat
 *   with HistoryView, PayrollReports, TeamDashboard, etc.
 *
 * Never hard-deletes. Status remains "active" (future Admin can correct/void).
 */

/**
 * Resolve the logical work date + wall-clock time for a punch. When an
 * employee `timezone` is provided, the local calendar date/time in that zone
 * is used (so the entry doc id `${uid}_${localDate}` and the HH:MM manual
 * strings are the employee's own local day); otherwise the canonical
 * America/Los_Angeles values are used to preserve existing behaviour.
 */
function workDateTime(timezone?: string): { date: string; time: string } {
  if (timezone) {
    return { date: getLocalDate(timezone), time: getLocalTimeHHMM(timezone) };
  }
  return { date: getCurrentPTDate(), time: getCurrentPTTimeHHMM() };
}

/** Subtract N days from the resolved work date, in the employee's zone. */
function subtractWorkDays(dateStr: string, days: number, timezone?: string): string {
  if (timezone) return subtractLocalDays(dateStr, days, timezone);
  return subtractPTDays(dateStr, days);
}

export interface PunchStatus {
  entry: TimeEntry | null;
  activeSegment: TimeSegment | null;
  isClockedIn: boolean;
  isOnLunch: boolean;
  todayTotalMinutes: number;
  /**
   * Actual WORK minutes today (excludes breaks). For an open shift this is
   * the live estimate excluding any completed or in-progress lunch break.
   */
  workMinutes: number;
  /** Total BREAK minutes today (lunch durations, including an in-progress one). */
  breakMinutes: number;
  currentPTTime: string;
  currentPTDate: string;
  /**
   * Local-date → work-minutes totals for today's open entry, computed via the
   * automatic midnight split when an employee timezone is supplied. Keys are
   * the employee's local calendar dates (YYYY-MM-DD); a cross-midnight open
   * shift contributes its pre-midnight minutes to the prior date and its
   * post-midnight minutes to today. Omitted when no timezone is supplied.
   */
  totalsByLocalDate?: Record<string, number>;
}

export interface WeekSummary {
  totalMinutes: number;
  daysWorked: number;
  entries: TimeEntry[];
  weekStart: string;
  weekEnd: string;
}

/** Get or hydrate today's time entry for the user (employee local work date). */
export async function getTodayEntry(userId: string, timezone?: string): Promise<TimeEntry | null> {
  const { date } = workDateTime(timezone);
  return dbService.getTimeEntry(userId, date);
}

/**
 * Subtract N days from a PT YYYY-MM-DD date string, returning the PT
 * YYYY-MM-DD. Uses a PT-noon UTC anchor (matches the getPTWeekStart pattern)
 * to avoid DST/midnight-boundary off-by-one errors.
 */
function subtractPTDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d - days, 12, 0, 0));
  return getPTDate(anchor);
}

/**
 * S5: Locate the user's open shift across recent PT days.
 *
 * The "one open segment per employee" invariant can span PT days: an employee
 * who clocks in at 23:00 PT and clocks out at 02:00 PT has an open segment on
 * the PRIOR day's doc after midnight PT. Today's doc won't contain it, so
 * punchOut/getPunchStatus/toggleLunch must look beyond today to find the open
 * shift, close it, and keep the status card accurate across midnight.
 *
 * Fast path: today's doc (single getDoc). Fallback: last 3 PT days via a
 * range query (covers weekends + safety margin). Returns the most-recent
 * entry whose `getActiveSegment` is non-null, or null. Voided/archived docs
 * are skipped (getActiveSegment short-circuits them).
 *
 * Pure read; write callers re-read the target doc inside their transaction /
 * before updateDoc for consistency. Canonical workDate stays on the punch-in
 * PT day (correct payroll attribution per AGENTS.md §2).
 */
export async function findOpenShiftEntry(userId: string, timezone?: string): Promise<TimeEntry | null> {
  const { date: today } = workDateTime(timezone);
  // Fast path: today's doc.
  const todayEntry = await dbService.getTimeEntry(userId, today);
  if (todayEntry && getActiveSegment(todayEntry)) return todayEntry;
  // Fallback: scan recent days for a cross-midnight open shift.
  const start = subtractWorkDays(today, 3, timezone);
  const entries = await dbService.getTimeEntriesForUserInRange(userId, start, today);
  for (const e of entries) {
    if (todayEntry && e.id === todayEntry.id) continue; // already checked, no open segment
    if (getActiveSegment(e)) return e;
  }
  return null;
}

/** Core punch-in. Atomic. Rejects if open segment already exists. */
export async function punchIn(userId: string, taskId?: string, timezone?: string): Promise<TimeEntry> {
  const { date: ptDate, time: ptTime } = workDateTime(timezone);
  const now = Timestamp.now();
  const entryId = `${userId}_${ptDate}`;

  // S5: reject if there's already an open shift on ANY recent PT day, not
  // just today. Without this, a cross-midnight open shift on yesterday's doc
  // would be orphaned and a second open shift would start today, violating
  // the one-open-segment invariant. The transaction's own validateCanPunchIn
  // remains as a concurrency backstop for today's doc.
  const existingOpen = await findOpenShiftEntry(userId, timezone);
  if (existingOpen) {
    throw new Error(
      `You already have an open shift (started ${existingOpen.date}). Clock out before starting a new one.`
    );
  }

  // Layer 2: retry the transaction on transient network failures so a flaky
  // connection doesn't silently drop the clock-in (root cause of stuck open
  // shifts). Validation errors are not retried (withRetry checks the message).
  await withRetry(
    () => runTransaction(db, async (tx) => {
    const ref = doc(db, 'timeEntries', entryId);
    const snap = await tx.get(ref);

    let existing: TimeEntry | null = null;
    if (snap.exists()) {
      existing = /* map via simple shape */ {
        id: snap.id,
        userId,
        date: ptDate,
        // Include status so the voided/archived check in hasOpenSegmentLocal
        // can short-circuit. Without this, soft-voided test docs are still
        // treated as an open shift by validateCanPunchIn.
        status: snap.data().status,
        segments: Array.isArray(snap.data().segments) ? snap.data().segments : undefined,
        // minimal for hasOpen check
      } as TimeEntry;
    }

    const v = validateCanPunchIn(existing);
    if (!v.valid) {
      throw new Error(v.message || 'Cannot punch in');
    }

    const newSeg = createInitialSegment(ptTime, now.toMillis(), taskId);

    // Preserve any previously closed segments from this document so a split-shift
    // punch-in (after a previous punch-out) does not wipe out the archived work.
    // tx.set with merge:true REPLACES array fields rather than merging them, so
    // we explicitly build the full array here.
    const existingSegments = snap.exists() ? (snap.data().segments || []) : [];
    const existingCreatedAt = snap.exists() ? snap.data().createdAt : undefined;

    // When re-using a doc after a previous punch-out (split shift), clear the
    // legacy top-level clock-out fields so the new shift starts clean.
    const closedSegmentsTotal = (existingSegments as TimeSegment[])
      .filter((s) => s.complete)
      .reduce((sum, s) => sum + (s.workMinutes || 0), 0);

    const payload: Record<string, unknown> = {
      userId,
      workDate: ptDate,
      clockInManual: ptTime,
      clockInSystemTime: now,
      clockInSystem: now.toMillis(),
      currentStep: 2,
      dayComplete: false,
      complete: false,
      segments: [...existingSegments, stripUndefined(newSeg)],
      totalWorkMinutes: closedSegmentsTotal,
      createdBy: userId,
      updatedAt: now,
      updatedBy: userId,
      status: 'active',
      timezoneAtCreation: timezone ?? 'America/Los_Angeles',
      // Clear stale legacy fields from any previous closed shift on this doc
      clockOutManual: null,
      clockOutSystem: null,
      clockOutSystemTime: null,
      completedAt: null,
      lunchOutManual: null,
      lunchInManual: null,
      // Reset the lunch *System fields too — previously only the manual strings
      // were cleared, leaving the prior shift's lunch epoch (lunchOutSystemTime /
      // lunchInSystemTime) stale at the top level. The Audit Viewer then showed
      // the old shift's lunch submission as if it belonged to the new shift
      // (out-of-order: lunch stamped before the new clock-in).
      lunchOutSystem: null,
      lunchInSystem: null,
      lunchOutSystemTime: null,
      lunchInSystemTime: null,
      lunchSkipped: false,
      skipLunch: false,
    };
    if (existingCreatedAt !== undefined) payload.createdAt = existingCreatedAt;
    else payload.createdAt = now;

    tx.set(ref, payload, { merge: true });
    return { entryId, newSeg, ptDate, ptTime, wasCreated: !snap.exists() };
  }),
    { label: 'punchIn', retries: 3 },
  );

  // Return hydrated view (mapEntry will reconstruct)
  const fresh = await dbService.getTimeEntry(userId, ptDate);
  if (!fresh) throw new Error('Punch in succeeded but read failed');
  return fresh;
}

/** Clock out the open segment. */
export async function punchOut(userId: string, timezone?: string, dailyReport?: string): Promise<TimeEntry> {
  const { time: ptTime } = workDateTime(timezone);
  const now = Timestamp.now();

  // S5: locate the open shift across recent PT days. A cross-midnight shift
  // (e.g. 23:00 -> 02:00 PT) has its open segment on the PRIOR day's doc;
  // computing entryId from today's PT date would miss it and punch-out would
  // fail with "No open shift". We write the clock-out fields back to that
  // same doc, keeping its workDate as the punch-in PT day (canonical payroll
  // attribution, AGENTS.md §2). The ptTime (today's PT wall clock) is stored
  // as clockOutManual; closeActiveSegment's S6 wrap computes the correct
  // cross-midnight duration.
  const openEntry = await findOpenShiftEntry(userId, timezone);
  if (!openEntry) {
    throw new Error('No open shift to clock out of. Clock in first.');
  }
  const entryId = openEntry.id;
  const workDate = openEntry.date;

  // Layer 2: retry the transaction on transient network failures so a flaky
  // connection doesn't silently drop the clock-out (root cause of stuck open
  // shifts like 06-15/06-24/06-25/07-10). Validation errors are not retried.
  await withRetry(
    () => runTransaction(db, async (tx) => {
      const ref = doc(db, 'timeEntries', entryId);
      const snap = await tx.get(ref);

    let existing: TimeEntry | null = null;
    if (snap.exists()) {
      existing = {
        id: snap.id,
        userId,
        date: snap.data().workDate || workDate,
        status: snap.data().status,
        segments: Array.isArray(snap.data().segments) ? snap.data().segments : undefined,
        clockInManual: snap.data().clockInManual || undefined,
        clockOutManual: snap.data().clockOutManual || undefined,
        complete: snap.data().complete || snap.data().dayComplete || false,
      } as TimeEntry;
    }

    const v = validateCanPunchOut(existing);
    if (!v.valid) throw new Error(v.message);

    const active = getActiveSegment(existing);
    if (!active) throw new Error('No active segment');

    const archived = (existing?.segments || []).filter((s: TimeSegment) => s.id !== active.id);
    const preTotal = (existing?.totalWorkMinutes as number) || 0;

    // Local-midnight split: when an employee timezone is supplied and the open
    // segment crossed a local midnight, split it into per-local-day portions
    // and DISTRIBUTE each portion onto its own per-local-date doc
    // (`${userId}_${localDate}`). Storing the Day-2 portion on the punch-in
    // day's doc (the pre-fix behavior) caused the edit modal to render a
    // phantom third shift (the synthesized top-level "current" spanning
    // midnight), double-counted day totals, and payroll aggregating the
    // post-midnight portion under yesterday instead of today.
    let splitParts: SplitSegmentShape[] | null = null;
    if (timezone && typeof active.clockInSystem === 'number') {
      const parts = splitSegmentAcrossMidnights(
        { ...(active as SplitSegmentShape), id: active.id },
        now.toMillis(),
        timezone,
      );
      if (parts.length > 1 && parts[0].localDate === workDate) {
        splitParts = parts;
      }
    }

    if (!splitParts) {
      // Single-day close (or legacy no-timezone path): close in place on the
      // same doc, unchanged behavior.
      const closedSeg = closeActiveSegment(active, ptTime, now.toMillis());
      const finalSegments = [...archived, closedSeg].map((s) => stripUndefined(s));
      const newTotal = preTotal + (closedSeg.workMinutes || 0);

      tx.update(ref, {
        clockOutManual: ptTime,
        clockOutSystemTime: now,
        clockOutSystem: now.toMillis(),
        complete: true,
        currentStep: 4,
        dayComplete: true,
        completedAt: now.toMillis(),
        segments: finalSegments,
        totalWorkMinutes: newTotal,
        updatedAt: now,
        updatedBy: userId,
        // Daily Report modal (Remote employees): explicit write; empty string
        // when the modal was dismissed without text. Only set when supplied so
        // legacy callers (no dailyReport arg) leave any existing value intact.
        ...(dailyReport !== undefined ? { dailyReport } : {}),
      });

      return { entryId, closedSeg, finalSegments, newTotal };
    }

    // --- Cross-midnight split path ----------------------------------------
    // Close the final (still-open) portion at the actual punch-out instant.
    const lastPart = splitParts[splitParts.length - 1];
    const closedLast = closeActiveSegment(lastPart as TimeSegment, ptTime, now.toMillis());
    const allParts = [...splitParts.slice(0, -1), closedLast];

    // Firestore transactions require ALL reads before ANY write: fetch the
    // target docs for every portion beyond the first (which stays on the
    // original punch-in doc).
    const targetDocs: { date: string; ref: ReturnType<typeof doc>; exists: boolean; data: DocumentData | undefined }[] = [];
    for (let i = 1; i < allParts.length; i++) {
      const date = allParts[i].localDate!;
      const r = doc(db, 'timeEntries', `${userId}_${date}`);
      const s = await tx.get(r);
      targetDocs.push({ date, ref: r, exists: s.exists(), data: s.exists() ? s.data() : undefined });
    }

    // Original doc: keep the Day-1 portion (merged with any prior archived
    // segments). Top-level fields mirror THAT portion (not the full
    // cross-midnight span), so mapEntry no longer synthesizes a spanning
    // "current" that double-counts or renders as a phantom shift.
    const firstPart = allParts[0];
    const docASegments = [...archived, firstPart].map((s) => stripUndefined(s));
    const docATotal = preTotal + (firstPart.workMinutes || 0);
    tx.update(ref, {
      clockInManual: firstPart.clockInManual,
      clockOutManual: firstPart.clockOutManual,
      clockOutSystemTime: firstPart.clockOutSystem ? Timestamp.fromMillis(firstPart.clockOutSystem) : now,
      clockOutSystem: firstPart.clockOutSystem ?? now.toMillis(),
      lunchOutManual: firstPart.lunchOutManual ?? null,
      lunchInManual: firstPart.lunchInManual ?? null,
      skipLunch: !!firstPart.skipLunch,
      complete: true,
      currentStep: 4,
      dayComplete: true,
      completedAt: firstPart.clockOutSystem ?? now.toMillis(),
      segments: docASegments,
      totalWorkMinutes: docATotal,
      updatedAt: now,
      updatedBy: userId,
      // Daily Report modal (Remote employees): written to the punch-in day's
      // doc (the canonical shift doc). Empty string when dismissed blank.
      ...(dailyReport !== undefined ? { dailyReport } : {}),
    });

    // Day-2+ docs: one per local date, each closed with its own portion.
    for (let i = 1; i < allParts.length; i++) {
      const part = allParts[i];
      const t = targetDocs[i - 1];
      const existingSegs = t.exists && Array.isArray(t.data?.segments) ? (t.data!.segments as TimeSegment[]) : [];
      const existingTotal = t.exists ? ((t.data?.totalWorkMinutes as number) || 0) : 0;
      const payload: Record<string, unknown> = {
        userId,
        workDate: t.date,
        clockInManual: part.clockInManual,
        clockInSystemTime: part.clockInSystem ? Timestamp.fromMillis(part.clockInSystem) : now,
        clockInSystem: part.clockInSystem ?? now.toMillis(),
        clockOutManual: part.clockOutManual,
        clockOutSystemTime: part.clockOutSystem ? Timestamp.fromMillis(part.clockOutSystem) : now,
        clockOutSystem: part.clockOutSystem ?? now.toMillis(),
        lunchOutManual: part.lunchOutManual ?? null,
        lunchInManual: part.lunchInManual ?? null,
        skipLunch: !!part.skipLunch,
        currentStep: 4,
        complete: true,
        dayComplete: true,
        completedAt: part.clockOutSystem ?? now.toMillis(),
        segments: [...existingSegs, stripUndefined(part)],
        totalWorkMinutes: existingTotal + (part.workMinutes || 0),
        status: 'active',
        timezoneAtCreation: timezone,
        updatedAt: now,
        updatedBy: userId,
      };
      if (!t.exists) {
        payload.createdAt = now;
        payload.createdBy = userId;
      }
      tx.set(t.ref, payload, { merge: true });
    }

    return { entryId, closedSeg: closedLast, finalSegments: docASegments, newTotal: docATotal };
  }),
    { label: 'punchOut', retries: 3 },
  );

  // Re-read the SAME doc (workDate = punch-in PT day, which may be yesterday)
  // to return the hydrated view. dbService.getTimeEntry rebuilds entryId from
  // userId + workDate, which matches `entryId` above.
  const fresh = await dbService.getTimeEntry(userId, workDate);
  if (!fresh) throw new Error('Punch out succeeded but read failed');
  return fresh;
}

/** Toggle lunch on the current open segment (start or end). */
export async function toggleLunch(userId: string, skip = false, timezone?: string): Promise<TimeEntry> {
  const { time: ptTime } = workDateTime(timezone);
  const now = Timestamp.now();

  // S5: locate the open shift across recent PT days (cross-midnight support).
  // The open segment may live on a prior day's doc after midnight PT.
  const pre = await findOpenShiftEntry(userId, timezone);
  if (!pre) {
    throw new Error('No active segment for lunch');
  }
  const entryId = pre.id;
  const workDate = pre.date;

  const v = validateCanToggleLunch(pre);
  if (!v.valid) throw new Error(v.message);

  const active = getActiveSegment(pre);
  if (!active) throw new Error('No active segment for lunch');

  let action: 'start' | 'end' | 'skip' = 'start';
  if (skip) action = 'skip';
  else if (active.lunchOutManual || active.lunchOutSystem) action = 'end';

  const updatedSeg = applyLunchToSegment(active, action, ptTime, now.toMillis());

  // Dual update legacy lunch fields + the segment in place
  const patch: Record<string, unknown> = {
    updatedAt: now,
    updatedBy: userId,
  };

  if (action === 'start' || action === 'skip') {
    patch.lunchOutManual = skip ? '' : ptTime;
    patch.lunchOutSystemTime = skip ? null : now;
    patch.lunchSkipped = skip;
    patch.skipLunch = skip;
  }
  if (action === 'end') {
    patch.lunchInManual = ptTime;
    patch.lunchInSystemTime = now;
  }

  // Rebuild segments array with the updated one
  const newSegments = (pre?.segments || []).map((s) =>
    s.id === active.id ? stripUndefined(updatedSeg) : stripUndefined(s)
  );
  patch.segments = newSegments;

  // Layer 2: retry the update on transient network failures so a flaky
  // connection doesn't silently drop a lunch toggle.
  await withRetry(
    () => updateDoc(doc(db, 'timeEntries', entryId), patch),
    { label: 'toggleLunch', retries: 3 },
  );

  // Re-read the SAME doc (workDate may be a prior PT day after midnight).
  const fresh = await dbService.getTimeEntry(userId, workDate);
  if (!fresh) throw new Error('Lunch toggle succeeded but read failed');
  return fresh;
}

/** Rich status for the punch UI (today only). */
export async function getPunchStatus(userId: string, timezone?: string): Promise<PunchStatus> {
  const { date: ptDate, time: ptTime } = workDateTime(timezone);
  // S5: locate the open shift across recent PT days. After midnight PT, the
  // open segment lives on a prior day's doc; without this the status card
  // would flip to "CLOCK IN" while the employee is still on shift.
  const entry = await findOpenShiftEntry(userId, timezone);
  const active = getActiveSegment(entry);

  const isOnLunch =
    !!active &&
    (active.lunchOutManual || active.lunchOutSystem) &&
    !(active.lunchInManual || active.lunchInSystem) &&
    !active.skipLunch;

  // Compute work + break minutes separately so the UI can show a Work/Break
  // breakdown instead of a single misleading "total including lunch" figure.
  // For CLOSED segments, workMinutes already excludes lunch (closeActiveSegment
  // subtracts it); break = lunchIn - lunchOut. For the ACTIVE open segment,
  // we compute the live estimate excluding any completed or in-progress break.
  let workMinutes = 0;
  let breakMinutes = 0;
  if (entry?.segments?.length) {
    for (const s of entry.segments) {
      if (s.complete) {
        // SSOT: recompute via computeSegmentWorkMinutes (hybrid) so an edited
        // shift's total reflects the manual punch times, not stale stored
        // workMinutes / system timestamps.
        workMinutes += computeSegmentWorkMinutes(s);
        if (s.lunchOutManual && s.lunchInManual && !s.skipLunch) {
          const lo = timeStringToMinutes(s.lunchOutManual);
          const li = timeStringToMinutes(s.lunchInManual);
          const effLo = lo < timeStringToMinutes(s.clockInManual || '00:00') ? lo + 24 * 60 : lo;
          const effLi = li < timeStringToMinutes(s.clockInManual || '00:00') ? li + 24 * 60 : li;
          breakMinutes += Math.max(0, effLi - effLo);
        }
      }
    }
    if (active && !active.complete) {
      const inM = timeStringToMinutes(active.clockInManual || ptTime);
      const nowM = timeStringToMinutes(ptTime);
      // S6: cross-midnight wrap for live elapsed.
      const effNowM = nowM < inM ? nowM + 24 * 60 : nowM;
      const hasLunchOut = !!active.lunchOutManual;
      const hasLunchIn = !!active.lunchInManual;
      if (isOnLunch && active.lunchOutManual) {
        // Currently ON lunch: work up to lunch start; break = now - lunchOut.
        const lunchOutM = timeStringToMinutes(active.lunchOutManual);
        const effLunchOutM = lunchOutM < inM ? lunchOutM + 24 * 60 : lunchOutM;
        workMinutes += Math.max(0, effLunchOutM - inM);
        breakMinutes += Math.max(0, effNowM - effLunchOutM);
      } else if (hasLunchOut && hasLunchIn) {
        // Lunch done, back working: work = (lunchOut-in) + (now-lunchIn).
        const lunchOutM = timeStringToMinutes(active.lunchOutManual!);
        const lunchInM = timeStringToMinutes(active.lunchInManual!);
        const effLunchOutM = lunchOutM < inM ? lunchOutM + 24 * 60 : lunchOutM;
        const effLunchInM = lunchInM < inM ? lunchInM + 24 * 60 : lunchInM;
        workMinutes += Math.max(0, effLunchOutM - inM) + Math.max(0, effNowM - effLunchInM);
        breakMinutes += Math.max(0, effLunchInM - effLunchOutM);
      } else {
        // No lunch yet (or skipLunch): full elapsed is work.
        workMinutes += Math.max(0, effNowM - inM);
      }
    }
  }
  // todayTotalMinutes kept for backward compat = work minutes (no longer
  // includes break for the open-not-on-lunch case — that was the misleading
  // behavior the Work/Break breakdown replaces).
  const todayTotal = workMinutes;

  // Local-date totals via the midnight split (only when an employee timezone
  // is supplied). The active open segment is split across any crossed local
  // midnights and each portion is attributed to its own local calendar date.
  let totalsByLocalDate: Record<string, number> | undefined;
  if (timezone && entry?.segments?.length) {
    const nowMs = Date.now();
    const splitSegs: SplitSegmentShape[] = [];
    for (const s of entry.segments) {
      if (s.complete) {
        // Closed portions keep their attributed date (their clock-in local date).
        splitSegs.push({
          ...(s as SplitSegmentShape),
          localDate:
            (s as SplitSegmentShape).localDate ??
            (typeof s.clockInSystem === 'number' ? localDateOf(s.clockInSystem, timezone) : undefined),
        });
      } else if (typeof s.clockInSystem === 'number') {
        splitSegs.push(...splitSegmentAcrossMidnights({ ...(s as SplitSegmentShape) }, nowMs, timezone));
      } else {
        splitSegs.push({ ...(s as SplitSegmentShape) });
      }
    }
    totalsByLocalDate = {};
    for (const s of splitSegs) {
      const d = s.localDate;
      if (!d) continue;
      let mins = s.workMinutes;
      if (mins === undefined) {
        const inSys = s.clockInSystem;
        if (typeof inSys === 'number') {
          mins = Math.max(0, Math.round((nowMs - inSys) / 60000));
        } else mins = 0;
      }
      totalsByLocalDate[d] = (totalsByLocalDate[d] ?? 0) + mins;
    }
  }

  return {
    entry,
    activeSegment: active,
    isClockedIn: !!active,
    isOnLunch,
    todayTotalMinutes: Math.floor(todayTotal),
    workMinutes: Math.floor(workMinutes),
    breakMinutes: Math.floor(breakMinutes),
    currentPTTime: ptTime,
    currentPTDate: ptDate,
    ...(totalsByLocalDate ? { totalsByLocalDate } : {}),
  };
}

/** This week's summary (employee local week, Monday start). */
export async function getWeekSummary(userId: string, timezone?: string): Promise<WeekSummary> {
  const { date: ptDate } = workDateTime(timezone);
  const weekStart = timezone
    ? localWeekStart(ptDate, timezone)
    : getPTWeekStart(ptDate);
  // Simple 7-day window (inclusive)
  const weekEnd = ptDate; // today

  const rawEntries = await dbService.getTimeEntriesForUserInRange(userId, weekStart, weekEnd);
  // Skip soft-deleted docs (voided/archived) so they don't inflate totals.
  // Then explode pre-fix cross-midnight split docs: a 23:32→00:28 shift stored
  // on the 07/29 doc (with the 00:00→00:28 part attributed to localDate 07/30)
  // counts as work on BOTH local days — without this the "This Week" card
  // showed 1 day worked instead of 2 for that shift.
  const entries = explodeDocsBySegmentLocalDate(
    rawEntries.filter((e) => e.status !== 'voided' && e.status !== 'archived'),
  );

  let total = 0;
  const workedDates = new Set<string>();
  for (const e of entries) {
    // `entry.totalWorkMinutes` is the canonical day total maintained by
    // `mapEntry` (it includes archived + current-segment minutes, and falls
    // back to the stored legacy value when there are no segments). Legacy
    // TodayEntry docs have `totalWorkMinutes` set but `segments[]` empty, so
    // summing only `seg.workMinutes` silently dropped their entire day from
    // the week total. Prefer the day-total field; fall back to summing the
    // persisted segments when it is absent.
    const mins =
      typeof e.totalWorkMinutes === 'number'
        ? e.totalWorkMinutes
        : (e.segments?.reduce((s, seg) => s + (seg.workMinutes || 0), 0) || 0);
    total += mins;
    // Days worked = DISTINCT local calendar dates with work, not doc count
    // (two docs can share a date; one pre-fix doc can span two dates).
    if (mins > 0) workedDates.add(e.workDate ?? e.date);
  }

  return {
    totalMinutes: total,
    daysWorked: workedDates.size,
    entries,
    weekStart,
    weekEnd: ptDate,
  };
}

// Local helper (dupe of internal to avoid import)
function timeStringToMinutes(t?: string): number {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Monday-start week start (YYYY-MM-DD) for the employee's LOCAL week containing
 * the given local date. Mirrors getPTWeekStart but anchored to the employee's
 * local zone via the subtractLocalDays noon-anchor technique.
 */
function localWeekStart(localDateStr: string, timezone: string): string {
  // Weekday of the local date (0=Sun..6=Sat) via a noon-anchored local date.
  const [y, m, d] = localDateStr.split('-').map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const weekdayStr = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  }).format(noon);
  const map: Record<string, number> = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
  };
  const weekday = map[weekdayStr] ?? 0;
  const daysBack = (weekday + 6) % 7; // Monday start
  return subtractLocalDays(localDateStr, daysBack, timezone);
}

/**
 * Layer 2 fix: retry a punch write with exponential backoff so transient
 * network failures (the root cause of the employee's stuck open shifts) don't
 * silently drop the action. Offline persistence (firebase.ts) now buffers
 * writes in IndexedDB, but the awaiting Promise still rejects on network
 * errors before the buffer is confirmed — so the UI sees a failure and shows
 * the persistent error banner. This wrapper retries the op a few times before
 * surfacing the rejection, giving the buffer/reconnect path time to land the
 * write. Retries are only attempted for network-class errors, not for
 * validation rejections (e.g. "No open shift") which are deterministic.
 */
const NETWORK_ERROR_PATTERNS = [
  /network/i,
  /offline/i,
  /unavailable/i,
  /deadline-exceeded/i,
  /internal/i,
  /fetch/i,
  /failed to fetch/i,
  /connection/i,
];

function isTransientNetworkError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return NETWORK_ERROR_PATTERNS.some((p) => p.test(msg));
}

export async function withRetry<T>(
  op: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 800;
  const label = opts.label ?? 'operation';
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const transient = isTransientNetworkError(err);
      if (!transient || attempt === retries) {
        throw err;
      }
      // Exponential backoff with jitter: 800ms, ~1.6s, ~3.2s.
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 300;
      console.warn(`[clockService] ${label} attempt ${attempt + 1} failed (transient), retrying in ${Math.round(delay)}ms`, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
