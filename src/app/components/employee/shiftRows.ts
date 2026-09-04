import type { TimeEntry, TimeSegment } from '../../lib/database';
import { explodeDocsBySegmentLocalDate } from '../../../utils/timeView';

export interface ShiftRow {
  key: string;
  entry: TimeEntry;
  segment: TimeSegment;
  shiftNumber: number;
  totalShifts: number;
}

/**
 * Flatten entries into one row per shift/segment. A split-shift day with 2
 * segments produces 2 rows. The synthesized "current" segment (from top-level
 * fields) is included only when it is NOT a duplicate of the last archived
 * segment (the dual-write case in the ClockPunch flow).
 *
 * Entries are first exploded by segment localDate (explodeDocsBySegmentLocalDate)
 * so a pre-fix cross-midnight doc (23:32→00:28 split into 23:32→23:59 +
 * 00:00→00:28 but stored on one doc) renders as TWO rows with the correct
 * dates (07/29 and 07/30) instead of three rows all pinned to the punch-in
 * date — the synthesized top-level "current" spanning midnight is dropped.
 *
 * Rows are returned newest-date-first (stable: shifts within a date stay in
 * chronological order), matching the newest-first order used everywhere else.
 */
export function flattenToShiftRows(entries: TimeEntry[]): ShiftRow[] {
  const rows: ShiftRow[] = [];
  for (const entry of explodeDocsBySegmentLocalDate(entries)) {
    const segs = entry.segments ?? [];
    const current = entry.currentSegment ?? null;

    const allShifts: TimeSegment[] = [...segs];
    if (current) {
      const last = segs.length > 0 ? segs[segs.length - 1] : null;
      const isDup =
        last &&
        last.clockInManual === current.clockInManual &&
        last.complete === current.complete;
      if (!isDup) {
        allShifts.push(current);
      }
    }

    allShifts.forEach((seg, i) => {
      rows.push({
        key: `${entry.id}|${seg.id}`,
        entry,
        segment: seg,
        shiftNumber: i + 1,
        totalShifts: allShifts.length,
      });
    });
  }
  // Newest date first, matching the table's overall order (Firestore returns
  // workDate desc). The explosion above emits a pre-fix doc's dates ascending
  // (07/29 then 07/30); without this re-sort, the older date row appeared
  // above the newer one. Sort is stable, so shifts within the same date keep
  // their chronological segment order.
  rows.sort((a, b) => b.entry.date.localeCompare(a.entry.date));
  return rows;
}
