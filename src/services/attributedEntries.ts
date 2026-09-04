/**
 * Analytics read pipeline — the Analytics tab's data-gathering layer.
 *
 * `fetchAttributedTimeEntries` mirrors the Payroll tab's read exactly (same
 * Firestore query shape, same exclusion cutoff, same per-segment minutes
 * rebuild, same cross-midnight local-date attribution, same role-group
 * narrowing) so Analytics and Payroll never disagree about what the data is.
 * The ONLY intentional deviation is the `completeOnly` switch: Payroll passes
 * true (completed days only); Analytics may pass false to also surface open /
 * incomplete shifts.
 *
 * `projectOpenShiftsAt` (re-exported from utils/openShiftProjection — pure,
 * jest-testable, no firebase) then performs the IN-MEMORY virtual closure:
 * any still open segment is treated as if it clocked out at `now` purely for
 * calculation. This projection NEVER writes to Firestore — the returned docs
 * are copies tagged with `projectedOpen` / `projectedClosed` so the UI can
 * badge them (soft-delete/segments rules untouched: no writes at all here).
 */

import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import type { DocumentData } from 'firebase/firestore';
import { db } from '../app/lib/firebase';
import { computeSegmentWorkMinutes } from '../app/lib/segmentOps';
import type { TimeSegment } from '../app/lib/database';
import { filterByExclusionCutoff } from '../utils/exclusionFilter';
import { explodeDocsBySegmentLocalDate } from '../utils/timeView';
import { buildUserIdMatcher, isGroupSelection } from '../utils/userSelection';
import type { User } from '../app/lib/auth';

export { projectOpenShiftsAt } from '../utils/openShiftProjection';

export interface FetchAttributedEntriesOptions {
  /** Inclusive `workDate` lower bound, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive `workDate` upper bound, YYYY-MM-DD. */
  endDate: string;
  /** User dropdown value: a group sentinel (see userSelection) or a uid. */
  selectedUserId: string;
  allUsers: User[];
  /**
   * true (default) reproduces Payroll's `dayComplete === true` filter.
   * Analytics passes false so open/incomplete shifts are included.
   */
  completeOnly?: boolean;
  /**
   * "Exclude Records From Analysis" cutoff (YYYY-MM-DD, PT) from global
   * system settings. '' disables the cutoff.
   */
  excludeBefore?: string;
}

/**
 * Fetch + normalize time entries for a date range using the payroll-grade
 * pipeline. Each returned doc carries its Firestore `id` (or the
 * `${sourceId}@${date}` synthetic id for exploded cross-midnight parts).
 */
export async function fetchAttributedTimeEntries(
  opts: FetchAttributedEntriesOptions,
): Promise<DocumentData[]> {
  const {
    startDate,
    endDate,
    selectedUserId,
    allUsers,
    completeOnly = true,
    excludeBefore = '',
  } = opts;

  // Same query pattern as the Payroll tab: group selections (All / role
  // groups) fetch the full date range, then narrow by role below; a specific
  // user gets a server-side userId equality filter.
  const base = collection(db, 'timeEntries');
  const q =
    isGroupSelection(selectedUserId)
      ? query(base, where('workDate', '>=', startDate), where('workDate', '<=', endDate), orderBy('workDate', 'asc'))
      : query(
        base,
        where('userId', '==', selectedUserId),
        where('workDate', '>=', startDate),
        where('workDate', '<=', endDate),
        orderBy('workDate', 'asc')
      );

  const snap = await getDocs(q);
  const rawEntries = filterByExclusionCutoff(
    // Include the Firestore doc id so each entry carries a unique,
    // collision-free key (real `${uid}_${date}` id for normal docs; the
    // cross-midnight explosion derives `${sourceId}@${date}` synthetics).
    snap.docs.map(d => ({ id: d.id, ...d.data() }) as DocumentData).filter(e => !completeOnly || e.dayComplete === true),
    excludeBefore,
    (e: DocumentData) => String(e.workDate || e.date || ''),
  ).map(e => {
    // Rebuild the day's total from the canonical segments[] sum. Split-shift
    // (multi-segment) docs persist only the final shift's minutes in the root
    // totalWorkMinutes field; feeding the stale root value into downstream
    // consumers understates the day. Per-segment workMinutes is recomputed
    // from the system timestamp delta (clockInSystem/clockOutSystem) so
    // multi-day spans feed accurate durations; manual-only segments keep
    // their stored value via the computeSegmentWorkMinutes fallback.
    const segs = Array.isArray(e.segments) ? e.segments : [];
    if (segs.length === 0) return e;
    const rebuiltSegs = segs.map((s: DocumentData) => ({
      ...s,
      workMinutes: computeSegmentWorkMinutes(s as TimeSegment),
    }));
    const segTotal = rebuiltSegs.reduce((sum, s) => sum + (Number(s.workMinutes) || 0), 0);
    if (segs.length > 1) {
      return {
        ...e,
        segments: rebuiltSegs,
        totalWorkMinutes: segTotal,
        totalHours: segTotal / 60,
        regularMinutes: undefined,
        otMinutes: undefined,
        doubleTimeMinutes: undefined,
      };
    }
    // Single-segment docs keep root fields in sync with segments[0]
    // (S7 invariant); rebuild defensively but trust any stored buckets.
    return { ...e, segments: rebuiltSegs, totalWorkMinutes: segTotal, totalHours: segTotal / 60 };
  });

  // Attribute pre-fix cross-midnight split segments to their own local dates
  // (explode 23:32→00:28 into a 07/29 doc with 23:32→23:59 and a 07/30 doc
  // with 00:00→00:28) so consumers group the post-midnight portion under the
  // correct day instead of aggregating the whole shift under the punch-in date.
  const dateAttributedEntries = explodeDocsBySegmentLocalDate(rawEntries);

  // For role-group selections, drop entries whose owner's role doesn't match.
  // (A specific user is already server-filtered; "All" keeps everyone.)
  const roleMatcher = buildUserIdMatcher(selectedUserId, allUsers);
  return dateAttributedEntries.filter(e => roleMatcher(String(e.userId || '')));
}
