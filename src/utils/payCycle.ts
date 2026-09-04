/**
 * Remote employee pay-cycle engine (Stage 2).
 *
 * Computes custom monthly cycle boundaries anchored on an employee's
 * `remotePayCalculationDay` (1–28). A cycle runs from the anchor day of one
 * month through the day before the anchor day of the next month:
 *
 *   payDay = 11, today = Aug 31  →  Current Cycle: Aug 11 – Sep 10
 *                                   Last Cycle:    Jul 11 – Aug 10
 *
 *   payDay = 11, today = Aug 5   →  Current Cycle: Jul 11 – Aug 10
 *                                   Last Cycle:    Jun 11 – Jul 10
 *
 * Timezone: the reference "today" is a caller-supplied YYYY-MM-DD string —
 * the report components pass `getCurrentPTDate()`, keeping every admin
 * payroll cycle boundary in America/Los_Angeles per AGENTS.md. All month
 * arithmetic below is UTC-anchored (Date.UTC) so results never drift with
 * the browser's local zone, matching the existing weekly/biweekly/monthly
 * preset implementations in AnalyticsReport/PayrollReports.
 */

export interface PayCycleRange {
  /** YYYY-MM-DD, inclusive. */
  start: string;
  /** YYYY-MM-DD, inclusive. */
  end: string;
}

/** Clamp to the valid day-of-month range (1–28); non-finite → 1. */
export function normalizePayCalculationDay(day: unknown): number {
  const n = typeof day === 'number' && Number.isFinite(day) ? Math.round(day) : 1;
  return Math.min(28, Math.max(1, n));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The Current Cycle containing `todayYmd` for the given anchor day.
 * - today >= anchor day → starts on the anchor day of this month.
 * - today <  anchor day → starts on the anchor day of the previous month.
 * End = day before the next cycle's start (i.e. anchorDay − 1 of next month,
 * or the last day of the month when anchorDay is 1).
 */
export function computeRemoteCurrentCycle(todayYmd: string, remotePayCalculationDay: number): PayCycleRange {
  const anchor = normalizePayCalculationDay(remotePayCalculationDay);
  const [ty, tm, td] = todayYmd.split('-').map(Number);

  let startY = ty;
  let startM0 = tm - 1; // 0-indexed month
  if (td < anchor) {
    if (startM0 === 0) { startM0 = 11; startY -= 1; }
    else startM0 -= 1;
  }

  const start = new Date(Date.UTC(startY, startM0, anchor));
  // Date.UTC normalizes month overflow (startM0 + 1 === 12 → next January).
  const nextStart = new Date(Date.UTC(startY, startM0 + 1, anchor));
  const end = new Date(nextStart);
  end.setUTCDate(nextStart.getUTCDate() - 1);

  return { start: ymd(start), end: ymd(end) };
}

/**
 * The Last Cycle: the 1-month period immediately preceding the Current Cycle
 * containing `todayYmd` (start = anchor day one month earlier; end = day
 * before the Current Cycle's start).
 */
export function computeRemoteLastCycle(todayYmd: string, remotePayCalculationDay: number): PayCycleRange {
  const anchor = normalizePayCalculationDay(remotePayCalculationDay);
  const current = computeRemoteCurrentCycle(todayYmd, anchor);

  const [sy, sm] = current.start.split('-').map(Number);
  const startM0 = sm - 1;
  let lastY = sy;
  let lastM0 = startM0 - 1;
  if (lastM0 < 0) { lastM0 = 11; lastY -= 1; }

  const start = new Date(Date.UTC(lastY, lastM0, anchor));
  const end = new Date(Date.UTC(sy, startM0, anchor));
  end.setUTCDate(end.getUTCDate() - 1);

  return { start: ymd(start), end: ymd(end) };
}

/** Preset dispatcher matching the report components' 'current' | 'last' API. */
export function computeRemotePayCycle(
  preset: 'current' | 'last',
  todayYmd: string,
  remotePayCalculationDay: number,
): PayCycleRange {
  return preset === 'current'
    ? computeRemoteCurrentCycle(todayYmd, remotePayCalculationDay)
    : computeRemoteLastCycle(todayYmd, remotePayCalculationDay);
}
