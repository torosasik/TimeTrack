/**
 * One-time admin repair utility for historical runaway entries.
 *
 * Runs client-side under the signed-in admin (org policy blocks deploying
 * public callable invokers, and firestore.rules already allow admins to
 * update any timeEntry + append auditLogs — the same path "Correct Entry"
 * uses).
 *
 * Policy (mirrors the server-side autoGuardrails cron):
 *   - On-site: cap any shift segment at 10:00 PM local (next local day when
 *     the clock-in itself was after 10 PM).
 *   - Remote: cap any shift segment at 12 hours from its clock-in.
 *
 * BOTH still-open entries and completed entries (dayComplete === true) are
 * inspected: a completed entry whose segment ran past the cap (e.g. a 24-hour
 * "completed" runaway) is flagged and capped the same way.
 *
 * Totals are recomputed via the canonical read-side SSOT `getEntryTotals`
 * (AGENTS.md), the entry is flagged/autoClosed, and every repair writes the
 * immutable auditLogs row (mandatory reason) BEFORE the timeEntries mutation
 * (audit-mandatory-reason rule: no path may produce an unaudited correction —
 * an audit failure aborts the repair). Soft-update only — nothing is deleted.
 */
import { collection, doc, getDocs, query, serverTimestamp, Timestamp, updateDoc, where, type QueryDocumentSnapshot } from 'firebase/firestore';
import { db } from '../app/lib/firebase';
import { getEntryTotals, type TimeEntry } from '../app/lib/database';
import { stripUndefined } from '../app/lib/segmentOps';
import { getTimeZoneOffsetMs, localDateOf, localTimeHHMM, nextLocalMidnightMs } from '../utils/midnightSplit';
import { getCurrentPTDate } from '../utils/timeCalculations';
import { auditLogService } from './auditLogService';
import { fetchGlobalSettings, resolveGuardrailLimits, type GuardrailLimits } from './systemSettingsService';
import type { User } from '../app/lib/auth';

const PT_ZONE = 'America/Los_Angeles';
export const REPAIR_DEFAULT_START_DATE = '2026-08-10';
const REPAIR_REASON =
  'Admin one-time repair: retroactive cap of runaway shift per guardrail policy.';

/**
 * Default window end = today's date in PT. The scan window is interpreted as
 * PT calendar days (see windowStartMs/windowEndMs below), so the default must
 * be a PT date — the admin's device-local date would silently extend the
 * window into the next PT day (admins east of PT) or truncate today's PT
 * entries out of the scan (west of PT). (AGENTS.md: pay-affecting admin
 * controls run in PT, never on the browser's local Date.)
 */
export function repairDefaultEndDate(): string {
  return getCurrentPTDate();
}

export interface RepairPreview {
  entryId: string;
  userId: string;
  userName: string;
  workModel: string;
  timezone: string;
  /** Human-readable cap descriptions, one per repaired segment. */
  caps: string[];
  clockInSystem: number;
  totalWorkMinutes: number;
  /** True when the entry was already dayComplete before the repair. */
  wasComplete: boolean;
}

export interface RepairRunawayResult {
  dryRun: boolean;
  window: { startDate: string; endDate: string };
  scanned: number;
  repaired: number;
  repairs: RepairPreview[];
  skipped: { voided: number; noUser: number; noViolation: number };
}

function toMillis(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return value;
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return undefined;
}

/** Epoch ms of a wall-clock instant (YYYY-MM-DD + HH:MM) in the given zone. */
function localWallClockToMs(localDate: string, hhmm: string, timeZone: string): number {
  const [y, m, d] = localDate.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const naiveUTC = Date.UTC(y, m - 1, d, hh, mm, 0);
  // Same UTC-anchor-minus-offset iteration as midnightSplit.nextLocalMidnightMs.
  let x = naiveUTC - getTimeZoneOffsetMs(timeZone, naiveUTC);
  x = naiveUTC - getTimeZoneOffsetMs(timeZone, x);
  return x;
}

/**
 * Guardrail instants for a segment starting at `clockInMs`, from the ACTIVE
 * Settings → Automated Actions limits:
 *  - triggerMs: when the guardrail fires (violation threshold),
 *  - recordedMs: the clockOut actually stamped (onsiteRecordedTime on the
 *    clock-in local date; falls back to the trigger when it would precede
 *    the clock-in or postdate the trigger — night-shift guard).
 */
function computeGuardrailInstants(
  workModel: 'On-site' | 'Remote',
  clockInMs: number,
  timezone: string,
  limits: GuardrailLimits,
): { triggerMs: number; recordedMs: number } {
  if (workModel === 'Remote') {
    const trigger = clockInMs + limits.remoteMaxWorkHours * 60 * 60 * 1000;
    return { triggerMs: trigger, recordedMs: trigger };
  }
  const clockInDate = localDateOf(clockInMs, timezone);
  let trigger = localWallClockToMs(clockInDate, limits.onsiteLatestAllowedTime, timezone);
  if (trigger <= clockInMs) {
    // Clocked in after the cutoff — trigger at the NEXT local day's cutoff.
    const nextDate = localDateOf(nextLocalMidnightMs(clockInMs, timezone), timezone);
    trigger = localWallClockToMs(nextDate, limits.onsiteLatestAllowedTime, timezone);
  }
  let recorded = localWallClockToMs(clockInDate, limits.onsiteRecordedTime, timezone);
  if (recorded <= clockInMs || recorded > trigger) recorded = trigger;
  return { triggerMs: trigger, recordedMs: recorded };
}

interface SegmentPatch {
  clockOutManual: string;
  clockOutSystem: number;
  clockOutSystemTime: Timestamp;
  lunchOutManual?: string | null;
  lunchOutSystem?: number | null;
  lunchOutSystemTime?: Timestamp | null;
  lunchInManual?: string | null;
  lunchInSystem?: number | null;
  lunchInSystemTime?: Timestamp | null;
  complete: true;
  autoClosed: true;
  flagged: true;
}

/**
 * Build the close-at-cap patch for one segment (open OR completed-but-runaway).
 * Lunch is clamped to the cap: a lunch starting at/after the cap is removed;
 * a lunch straddling the cap ends at the cap.
 */
function buildSegmentCapPatch(seg: Record<string, any>, capMs: number, timezone: string): SegmentPatch { // eslint-disable-line @typescript-eslint/no-explicit-any
  const capManual = localTimeHHMM(capMs, timezone);
  const patch: SegmentPatch = {
    clockOutManual: capManual,
    clockOutSystem: capMs,
    clockOutSystemTime: Timestamp.fromMillis(capMs),
    complete: true,
    autoClosed: true,
    flagged: true,
  };

  const lo = toMillis(seg.lunchOutSystem ?? seg.lunchOutSystemTime);
  const li = toMillis(seg.lunchInSystem ?? seg.lunchInSystemTime);
  const skipLunch = seg.skipLunch === true || seg.lunchSkipped === true;
  if (!skipLunch && typeof lo === 'number') {
    if (lo >= capMs) {
      // Lunch began at/after the cap — it never happened within the capped span.
      patch.lunchOutManual = null;
      patch.lunchOutSystem = null;
      patch.lunchOutSystemTime = null;
      patch.lunchInManual = null;
      patch.lunchInSystem = null;
      patch.lunchInSystemTime = null;
    } else if (typeof li !== 'number' || li > capMs) {
      // Lunch straddles (or is open past) the cap — end it at the cap.
      patch.lunchInManual = capManual;
      patch.lunchInSystem = capMs;
      patch.lunchInSystemTime = Timestamp.fromMillis(capMs);
    }
  }
  return patch;
}

/** A segment is still open when it is not complete and has no clock-out. */
function segmentIsOpen(s: Record<string, any>): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (
    s.complete !== true &&
    !s.clockOutManual &&
    typeof toMillis(s.clockOutSystem ?? s.clockOutSystemTime) !== 'number'
  );
}

/**
 * Scan the window for runaway entries (open OR completed) and optionally
 * repair them. `dryRun: true` returns the preview list without writing.
 * Window defaults: 2026-08-10 through today (PT).
 */
export async function repairRunawayShifts(opts: {
  admin: User;
  usersById: Map<string, User>;
  startDate?: string;
  endDate?: string;
  dryRun?: boolean;
}): Promise<RepairRunawayResult> {
  const { admin, usersById } = opts;
  const startDate = opts.startDate || REPAIR_DEFAULT_START_DATE;
  const endDate = opts.endDate || repairDefaultEndDate();
  const dryRun = opts.dryRun === true;

  // Active Settings → Automated Actions limits drive BOTH the violation
  // threshold (latest allowed / remote max hours) and the RECORDED clock-out
  // (onsiteRecordedTime) — fetched once per scan.
  const limits = resolveGuardrailLimits(await fetchGlobalSettings());

  // PT-bounded window: clock-ins from 00:00 PT on startDate through end of endDate PT.
  const windowStartMs = localWallClockToMs(startDate, '00:00', PT_ZONE);
  const dayAfterEnd = localDateOf(nextLocalMidnightMs(localWallClockToMs(endDate, '12:00', PT_ZONE), PT_ZONE), PT_ZONE);
  const windowEndMs = localWallClockToMs(dayAfterEnd, '00:00', PT_ZONE);

  // Two queries, merged by doc id: modern docs carry the numeric
  // clockInSystem, but legacy TodayEntry docs persist ONLY clockInSystemTime
  // (a Firestore Timestamp) — a numeric range query can never match those, so
  // without the second query the repair would miss exactly the legacy
  // runaways it was built to fix.
  const base = collection(db, 'timeEntries');
  const [snapMs, snapTs] = await Promise.all([
    getDocs(query(base, where('clockInSystem', '>=', windowStartMs), where('clockInSystem', '<', windowEndMs))),
    getDocs(query(
      base,
      where('clockInSystemTime', '>=', Timestamp.fromMillis(windowStartMs)),
      where('clockInSystemTime', '<', Timestamp.fromMillis(windowEndMs)),
    )),
  ]);
  const docMap = new Map<string, QueryDocumentSnapshot>();
  for (const s of [...snapMs.docs, ...snapTs.docs]) docMap.set(s.id, s);

  const nowMs = Date.now();
  const repairs: RepairPreview[] = [];
  const skipped = { voided: 0, noUser: 0, noViolation: 0 };

  for (const docSnap of docMap.values()) {
    const entryId = docSnap.id;
    const d = docSnap.data() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (d.status === 'voided' || d.status === 'archived') { skipped.voided++; continue; }

    const user = usersById.get(String(d.userId || ''));
    if (!user) { skipped.noUser++; continue; }

    const workModel: 'On-site' | 'Remote' = user.workModel === 'Remote' ? 'Remote' : 'On-site';
    const timezone = user.timezone && user.timezone.trim() ? user.timezone : PT_ZONE;

    const segments: Record<string, any>[] = Array.isArray(d.segments) ? d.segments : []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const isFlatDoc = segments.length === 0;

    // Evaluate every segment (or the flat top-level punch): a violation is a
    // segment whose (actual or, for open segments, current) end exceeds its
    // policy cap. Completed entries are inspected too — a "completed" 24-hour
    // runaway is still a runaway.
    //
    // Patches are keyed by segment INDEX, not id: legacy rows may lack
    // segment ids, and an id-keyed lookup would cross-match every id-less
    // segment to the FIRST undefined-id patch (wrong cap written, later
    // patches silently dropped).
    const segmentPatches = new Map<number, SegmentPatch>();
    let flatPatch: SegmentPatch | null = null;
    let flatClockInMs: number | undefined;
    // The documented legacy shape (database.ts: open seg lives ONLY in the
    // top-level fields while segments[] ends in a CLOSED segment).
    let topLevelPatch: SegmentPatch | null = null;
    let topLevelClockInMs: number | undefined;
    const caps: string[] = [];

    const capDescription = (capMs: number) =>
      `${localDateOf(capMs, timezone)} ${localTimeHHMM(capMs, timezone)} ${timezone}`;

    if (isFlatDoc) {
      if (!d.clockInManual) { skipped.noViolation++; continue; }
      const inMs = toMillis(d.clockInSystem ?? d.clockInSystemTime);
      if (typeof inMs !== 'number') { skipped.noViolation++; continue; }
      const outMs = toMillis(d.clockOutSystem ?? d.clockOutSystemTime);
      const isOpen = !d.clockOutManual && d.dayComplete !== true;
      if (!isOpen && typeof outMs !== 'number') { skipped.noViolation++; continue; }
      const { triggerMs, recordedMs: capMs } = computeGuardrailInstants(workModel, inMs, timezone, limits);
      const violates = isOpen ? nowMs > triggerMs : (outMs as number) > triggerMs;
      if (!violates) { skipped.noViolation++; continue; }
      flatClockInMs = inMs;
      flatPatch = buildSegmentCapPatch(
        {
          clockInSystem: inMs,
          lunchOutSystem: toMillis(d.lunchOutSystem ?? d.lunchOutSystemTime),
          lunchInSystem: toMillis(d.lunchInSystem ?? d.lunchInSystemTime),
          skipLunch: d.skipLunch === true || d.lunchSkipped === true,
        },
        capMs,
        timezone,
      );
      caps.push(capDescription(capMs));
    } else {
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const inMs = toMillis(s.clockInSystem ?? s.clockInSystemTime);
        if (typeof inMs !== 'number') continue;
        const outMs = toMillis(s.clockOutSystem ?? s.clockOutSystemTime);
        const isOpen = segmentIsOpen(s);
        if (!isOpen && typeof outMs !== 'number') continue; // unusable segment
        const { triggerMs, recordedMs: capMs } = computeGuardrailInstants(workModel, inMs, timezone, limits);
        const violates = isOpen ? nowMs > triggerMs : (outMs as number) > triggerMs;
        if (!violates) continue;
        segmentPatches.set(i, buildSegmentCapPatch(s, capMs, timezone));
        caps.push(capDescription(capMs));
      }

      // Top-level-only open shift: when the last persisted segment is CLOSED
      // but the top-level fields still show an open punch, the live shift
      // exists only in the top-level fields and the segment loop above can
      // never see it. (When the last segment is itself open, top-level merely
      // mirrors it via dual-write and is already covered by the loop.)
      const lastSegClosed = !segmentIsOpen(segments[segments.length - 1]);
      const topLevelOpen = !!d.clockInManual && !d.clockOutManual && d.dayComplete !== true;
      if (topLevelOpen && lastSegClosed) {
        const inMs = toMillis(d.clockInSystem ?? d.clockInSystemTime);
        if (typeof inMs === 'number') {
          const { triggerMs, recordedMs: capMs } = computeGuardrailInstants(workModel, inMs, timezone, limits);
          if (nowMs > triggerMs) {
            topLevelClockInMs = inMs;
            topLevelPatch = buildSegmentCapPatch(
              {
                clockInSystem: inMs,
                lunchOutSystem: toMillis(d.lunchOutSystem ?? d.lunchOutSystemTime),
                lunchInSystem: toMillis(d.lunchInSystem ?? d.lunchInSystemTime),
                skipLunch: d.skipLunch === true || d.lunchSkipped === true,
              },
              capMs,
              timezone,
            );
            caps.push(capDescription(capMs));
          }
        }
      }

      if (!segmentPatches.size && !topLevelPatch) { skipped.noViolation++; continue; }
    }

    // Build the final segment list. The capped top-level-only shift is
    // MATERIALIZED as a segment (the segments[] array is the canonical model
    // — AGENTS.md) so read-side totals and the write agree.
    let finalSegments: Record<string, any>[] | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!isFlatDoc) {
      finalSegments = segments.map((s, i) => {
        const p = segmentPatches.get(i);
        return p ? { ...s, ...p } : s;
      });
      if (topLevelPatch && typeof topLevelClockInMs === 'number') {
        finalSegments.push(stripUndefined({
          id: `seg_repair_${Date.now()}`,
          clockInManual: d.clockInManual,
          clockInSystem: topLevelClockInMs,
          lunchOutManual: d.lunchOutManual ?? undefined,
          lunchOutSystem: toMillis(d.lunchOutSystem ?? d.lunchOutSystemTime),
          lunchInManual: d.lunchInManual ?? undefined,
          lunchInSystem: toMillis(d.lunchInSystem ?? d.lunchInSystemTime),
          skipLunch: d.skipLunch === true || d.lunchSkipped === true,
          ...topLevelPatch,
        }));
      }
    }

    // Completion flags are set ONLY when no open shift remains — capping one
    // segment must not mark the day complete while another (below-cap) shift
    // is still open, or the cron's dayComplete==false query would lose track
    // of it and live minutes would vanish from the persisted day total.
    const anyOpen = finalSegments ? finalSegments.some(segmentIsOpen) : false;

    // Recompute the day total via the canonical read-side SSOT
    // (getEntryTotals) so History/Team/Payroll all agree.
    let patchedForTotals: Partial<TimeEntry>;
    if (!isFlatDoc) {
      patchedForTotals = {
        ...(d as Partial<TimeEntry>),
        segments: finalSegments as TimeEntry['segments'],
        currentSegment: undefined,
        complete: !anyOpen,
      };
    } else {
      patchedForTotals = {
        ...(d as Partial<TimeEntry>),
        ...flatPatch,
        currentSegment: undefined,
        segments: undefined,
        complete: true,
        // Drop any stale stored total so getEntryTotals derives from the
        // (now-closed) manual punch span instead of returning it.
        totalWorkMinutes: undefined,
      };
    }
    const { totalWorkMinutes } = getEntryTotals(patchedForTotals);

    const firstInMs = isFlatDoc
      ? (flatClockInMs as number)
      : (toMillis(segments[0].clockInSystem ?? segments[0].clockInSystemTime) as number);

    repairs.push({
      entryId,
      userId: String(d.userId || ''),
      userName: user.name,
      workModel,
      timezone,
      caps,
      clockInSystem: firstInMs,
      totalWorkMinutes,
      wasComplete: d.dayComplete === true || d.complete === true,
    });

    if (dryRun) continue;

    const patch: Record<string, unknown> = {
      autoClosed: true,
      flagged: true,
      totalWorkMinutes,
      totalHours: totalWorkMinutes / 60,
      updatedAt: serverTimestamp(),
      updatedBy: admin.uid,
    };
    if (!anyOpen) {
      patch.complete = true;
      patch.dayComplete = true;
      patch.currentStep = 4;
      const lastOutMs = finalSegments
        ? Math.max(
            ...finalSegments
              .map((s) => toMillis(s.clockOutSystem ?? s.clockOutSystemTime) ?? 0),
          )
        : (flatPatch as SegmentPatch).clockOutSystem;
      if (lastOutMs > 0) patch.completedAt = Timestamp.fromMillis(lastOutMs);
    }

    if (finalSegments) {
      patch.segments = finalSegments;
      // Keep the dual-written top-level punch fields mirroring the LAST
      // segment when that segment was the one capped, and always when the
      // top-level-only shift itself was capped (it IS the top-level shape).
      if (topLevelPatch) {
        patch.clockOutManual = topLevelPatch.clockOutManual;
        patch.clockOutSystem = topLevelPatch.clockOutSystem;
        patch.clockOutSystemTime = topLevelPatch.clockOutSystemTime;
        for (const k of ['lunchOutManual', 'lunchOutSystem', 'lunchOutSystemTime', 'lunchInManual', 'lunchInSystem', 'lunchInSystemTime'] as const) {
          if (topLevelPatch[k] !== undefined) patch[k] = topLevelPatch[k];
        }
      } else {
        const lastPatch = segmentPatches.get(segments.length - 1);
        if (lastPatch) {
          patch.clockOutManual = lastPatch.clockOutManual;
          patch.clockOutSystem = lastPatch.clockOutSystem;
          patch.clockOutSystemTime = lastPatch.clockOutSystemTime;
          for (const k of ['lunchOutManual', 'lunchOutSystem', 'lunchOutSystemTime', 'lunchInManual', 'lunchInSystem', 'lunchInSystemTime'] as const) {
            if (lastPatch[k] !== undefined) patch[k] = lastPatch[k];
          }
        }
      }
    } else if (flatPatch) {
      Object.assign(patch, flatPatch);
      patch.completedAt = flatPatch.clockOutSystemTime;
    }

    // Mandatory immutable audit row FIRST (audit-mandatory-reason rule): if
    // the audit write fails, the timeEntries mutation never happens — no
    // correction may land without its audit row.
    await auditLogService.logTimeCorrection({
      actorUid: admin.uid,
      actorName: admin.name,
      actorRole: 'admin',
      targetId: entryId,
      before: {
        clockInSystem: firstInMs,
        clockOutSystem: toMillis(d.clockOutSystem ?? d.clockOutSystemTime) ?? null,
        dayComplete: d.dayComplete ?? null,
        totalWorkMinutes: d.totalWorkMinutes ?? null,
      },
      after: {
        cappedSegments: caps,
        dayComplete: !anyOpen,
        totalWorkMinutes,
        autoClosed: true,
        flagged: true,
      },
      // Audit reason records the ACTIVE configured cutoff + recorded times
      // (audit-log-alignment requirement): future readers see exactly which
      // rule values produced this correction.
      reason: `${REPAIR_REASON} (${workModel}; on-site cutoff ${limits.onsiteLatestAllowedTime} recorded as ${limits.onsiteRecordedTime}, remote max ${limits.remoteMaxWorkHours}h; ${caps.length} segment(s) capped: ${caps.join('; ')}.)`,
    });
    await updateDoc(doc(db, 'timeEntries', entryId), patch);
  }

  return {
    dryRun,
    window: { startDate, endDate },
    scanned: docMap.size,
    repaired: dryRun ? 0 : repairs.length,
    repairs,
    skipped,
  };
}