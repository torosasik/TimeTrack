/**
 * Automatic local-midnight shift splitting (pure, jest-testable, no firebase).
 *
 * Requirement: when a shift crosses midnight in the EMPLOYEE's local timezone,
 * the day must be split so that:
 *  - the Day 1 portion closes at 11:59:59 PM local, and
 *  - a Day 2 portion opens at 12:00:00 AM local for the next calendar day.
 * Totals are attributed to the local calendar date of each split portion.
 *
 * This module is pure (no firebase imports) so it can be unit-tested in jest.
 * The clock/calculation layer calls into it; storage stays epoch-millis based
 * (`clockInSystem`/`clockOutSystem`), while the `*Manual` HH:MM strings are
 * written in the employee's LOCAL wall clock for these split boundaries.
 */

export interface SplitSegmentShape {
  id: string;
  clockInManual?: string;
  clockInSystem?: number;
  lunchOutManual?: string;
  lunchOutSystem?: number;
  lunchInManual?: string;
  lunchInSystem?: number;
  clockOutManual?: string;
  clockOutSystem?: number;
  skipLunch?: boolean;
  workMinutes?: number;
  complete?: boolean;
  taskId?: string;
  autoClosed?: boolean;
  /** Local calendar date (YYYY-MM-DD) this portion is attributed to. */
  localDate?: string;
  /** Marks a segment produced by the automatic midnight split. */
  splitFromMidnight?: boolean;
}

/** Milliseconds offset of the zone ahead of UTC at the given instant. */
export function getTimeZoneOffsetMs(timeZone: string, atMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(atMs));
  const num = (t: string): number => {
    const v = parts.find((p) => p.type === t)?.value;
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  };
  // Reconstruct the wall clock the zone shows, as if it were UTC.
  const asUTC = Date.UTC(
    num('year'),
    num('month') - 1,
    num('day'),
    num('hour'),
    num('minute'),
    num('second'),
  );
  // Round to the second to avoid ms noise from formatToParts.
  return Math.floor(asUTC / 1000) * 1000 - Math.floor(atMs / 1000) * 1000;
}

/** Local calendar date (YYYY-MM-DD) of an instant in the given zone. */
export function localDateOf(atMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(atMs));
}

/** Local HH:MM (24h) wall clock of an instant in the given zone. */
export function localTimeHHMM(atMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(atMs));
}

/**
 * Epoch ms of the next local 00:00:00 (midnight) strictly after `atMs` in the
 * given zone. Uses the UTC-anchor-minus-offset technique with one refinement
 * iteration to stay correct across DST transitions.
 */
export function nextLocalMidnightMs(atMs: number, timeZone: string): number {
  const localDate = localDateOf(atMs, timeZone);
  const [y, m, d] = localDate.split('-').map(Number);
  // Naive UTC midnight of the next local calendar day (the "wall clock" value
  // we want, interpreted as if it were UTC).
  const naiveUTC = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  // We want the UTC instant X whose local wall clock equals naiveUTC, i.e.
  // X = naiveUTC - offset(X). Iterate from a fixed base so it converges (the
  // second pass absorbs DST edges); do NOT subtract from a running guess.
  let x = naiveUTC - getTimeZoneOffsetMs(timeZone, naiveUTC);
  x = naiveUTC - getTimeZoneOffsetMs(timeZone, x);
  return x;
}

export interface MidnightSplitResult {
  /** Day 1 portion, closed at local 23:59:59. */
  day1: SplitSegmentShape;
  /** Day 2 portion, opened at local 00:00:00 for the next calendar day. */
  day2: SplitSegmentShape;
  /** The local midnight boundary (epoch ms) used for the split. */
  midnightMs: number;
}

const ONE_SECOND = 1000;

/**
 * Compute the automatic split for a single open segment, given "now". Returns
 * null when the segment has NOT crossed a local midnight (single-day shift) —
 * in that case the caller should leave it as one segment.
 *
 * Handles the lunch-at-midnight edge case: if the segment is ON lunch at the
 * boundary (lunchOut set, lunchIn not set), Day 1 closes both shift and lunch
 * at 23:59:59, and Day 2 opens already "On Lunch" (lunchOut set, lunchIn
 * unset) so a later "End Lunch" closes the Day 2 lunch and returns to Clocked In.
 */
export function splitOpenSegmentAtLocalMidnight(
  seg: SplitSegmentShape,
  nowMs: number,
  timeZone: string,
): MidnightSplitResult | null {
  if (typeof seg.clockInSystem !== 'number') return null;
  const startMs = seg.clockInSystem;
  const midnightMs = nextLocalMidnightMs(startMs, timeZone);
  // Crossed midnight only if "now" is at/after the next local midnight.
  if (nowMs < midnightMs) return null;

  const day1EndMs = midnightMs - ONE_SECOND; // local 23:59:59
  const day1Date = localDateOf(startMs, timeZone);
  const day2Date = localDateOf(midnightMs, timeZone);

  const onLunch = !!seg.lunchOutSystem && !seg.lunchInSystem && !seg.skipLunch;

  // --- Day 1: closed at 23:59:59 local -------------------------------------
  const day1: SplitSegmentShape = {
    ...seg,
    id: `${seg.id}_d1`,
    clockOutManual: localTimeHHMM(day1EndMs, timeZone),
    clockOutSystem: day1EndMs,
    complete: true,
    autoClosed: true,
    splitFromMidnight: true,
    localDate: day1Date,
  };
  if (onLunch) {
    // Close the lunch at the boundary too.
    day1.lunchInManual = localTimeHHMM(day1EndMs, timeZone);
    day1.lunchInSystem = day1EndMs;
  }
  day1.workMinutes = computeSpanWorkMinutes(day1, day1EndMs);

  // --- Day 2: opened at 00:00:00 local for the next day --------------------
  const day2: SplitSegmentShape = {
    id: `${seg.id}_d2`,
    clockInManual: localTimeHHMM(midnightMs, timeZone),
    clockInSystem: midnightMs,
    complete: false,
    splitFromMidnight: true,
    localDate: day2Date,
  };
  if (seg.taskId) day2.taskId = seg.taskId;
  if (onLunch) {
    // Day 2 resumes in the "On Lunch" state; lunchIn stays unset until the
    // employee taps "End Lunch".
    day2.lunchOutManual = localTimeHHMM(midnightMs, timeZone);
    day2.lunchOutSystem = midnightMs;
  }

  return { day1, day2, midnightMs };
}

/**
 * Recursively split a segment across MULTIPLE midnights (a very long shift).
 * Returns the list of segments in chronological order: the leading complete
 * portions followed by the final open (or complete) portion for "today".
 */
export function splitSegmentAcrossMidnights(
  seg: SplitSegmentShape,
  nowMs: number,
  timeZone: string,
): SplitSegmentShape[] {
  const out: SplitSegmentShape[] = [];
  let current = seg;
  // Guard against pathological loops (e.g. a year-long forgotten shift).
  for (let i = 0; i < 400; i++) {
    const split = splitOpenSegmentAtLocalMidnight(current, nowMs, timeZone);
    if (!split) {
      out.push({ ...current, localDate: current.localDate ?? localDateOf(current.clockInSystem ?? nowMs, timeZone) });
      return out;
    }
    out.push(split.day1);
    current = split.day2;
  }
  out.push(current);
  return out;
}

/** Work minutes for a (closed) span from system timestamps, lunch-aware. */
function computeSpanWorkMinutes(seg: SplitSegmentShape, clockOutSystemMs: number): number {
  const inSys = seg.clockInSystem;
  if (typeof inSys !== 'number') return seg.workMinutes ?? 0;
  const grossMin = Math.max(0, Math.round((clockOutSystemMs - inSys) / (1000 * 60)));
  if (seg.skipLunch) return grossMin;
  let lunch = 0;
  const lo = seg.lunchOutSystem;
  const li = seg.lunchInSystem;
  if (typeof lo === 'number' && typeof li === 'number' && li >= lo) {
    lunch = Math.max(0, Math.round((li - lo) / (1000 * 60)));
  }
  return Math.max(0, grossMin - lunch);
}

/**
 * Aggregate split segments by their attributed LOCAL calendar date.
 * Returns a map of localDate → total work minutes (open portions counted via
 * `nowMs` as their provisional end). Useful for daily/weekly/monthly totals
 * assigned strictly to each segment's local date.
 */
export function totalsByLocalDate(
  segs: SplitSegmentShape[],
  nowMs: number,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const s of segs) {
    const date = s.localDate ?? (s.clockInSystem ? localDateOf(s.clockInSystem, 'America/Los_Angeles') : undefined);
    if (!date) continue;
    let mins = s.workMinutes;
    if (mins === undefined) {
      // Open portion: provisional minutes up to "now", lunch-aware.
      mins = computeSpanWorkMinutes({ ...s, lunchInSystem: s.lunchInSystem }, nowMs);
    }
    totals[date] = (totals[date] ?? 0) + mins;
  }
  return totals;
}
