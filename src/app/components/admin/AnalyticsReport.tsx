import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react';
import { User } from '../../lib/auth';
import { SectionHelp } from '../ui/section-help';
import { OvertimeRulesInfo } from '../ui/overtime-rules-info';
import { TimezoneViewToggle } from '../ui/timezone-view-toggle';
import type { DocumentData } from 'firebase/firestore';
import { fetchGlobalSettings } from '../../../services/systemSettingsService';
import { fetchAttributedTimeEntries, projectOpenShiftsAt } from '../../../services/attributedEntries';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../ui/select';
import { toast } from 'sonner';
import { FileText, Printer, Download, DollarSign, Clock, TrendingUp, Radio, Users, Flag, Percent, Activity, ChevronDown, ClipboardList } from 'lucide-react';
import { generateCSV, downloadCSV } from '../../../services/exportService';
import { ALL_USERS, USER_GROUP_OPTIONS, isGroupSelection } from '../../../utils/userSelection';
import { DailyBreakdownTable } from './DailyBreakdownTable';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - JS module
import { calculateBiweeklyOvertimeTotals, formatMinutesToHHMM } from '../../../utils/overtimeCalculations.js';
import type { OvertimeEntry } from '../../../utils/overtimeCalculations';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - JS module
import { formatDateShortWithWeekday } from '../../../utils/dateHelpers.js';
import { epochFromLocalWallTime, getCurrentPTDate, getEmployeeTimezone } from '../../../utils/timeCalculations';
import { computeRemotePayCycle } from '../../../utils/payCycle';
import { isRemoteWorkModel } from '../../../utils/workModelUtils';
import { getSegmentFlags, getParentRowFlags, FLAG_LABELS, FLAG_SEVERITY } from '../../../utils/analyticsFlags';
import { listWorkModels, type WorkModel as WorkModelDef } from '../../../services/workModelsService';
import { type TimeViewMode, displayTimeForView, zoneForMode, calendarDayOffsetInZone } from '../../../utils/timeView';

// Uniform chip geometry for every pill rendered inside Daily Breakdown rows
// (status badges, missing-lunch marker, flag chips). h-4 + leading-none makes
// each chip exactly 16px tall — identical to the text-xs line box of plain
// cells — so chip rows and plain-text rows share the same baseline height and
// a row only grows when flag chips wrap to a second line.
const CHIP_CLASS =
  'inline-flex items-center h-4 whitespace-nowrap rounded border px-1.5 leading-none';

interface AnalyticsReportProps {
  allUsers: User[];
  /** The signed-in user (drives admin-only Bulk Edit in Daily Breakdown). */
  currentUser: User;
  /**
   * Admin timezone view (Req 4). 'local' = employee local tz (default),
   * 'pt' = America/Los_Angeles. Display-only; conversion uses the absolute
   * epoch system timestamps so stored data is never mutated.
   */
  timeViewMode?: TimeViewMode;
  /** Called when the admin switches the timezone view toggle in the header. */
  onTimeViewChange?: (mode: TimeViewMode) => void;
}

interface PayrollSummary {
  userId: string;
  userName: string;
  workModel: string;
  /** Direct HH:MM duration strings (e.g. '97:12') from the OT pipeline. */
  regularHours: string;
  overtimeHours: string;
  doubleTimeHours: string;
  totalHours: string;
  dailyEntries?: DocumentData[];
}

export function AnalyticsReport({ allUsers, currentUser, timeViewMode = 'local', onTimeViewChange }: AnalyticsReportProps) {
  const [selectedUserId, setSelectedUserId] = useState<string>(ALL_USERS);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [report, setReport] = useState<PayrollSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  // Accordion state for the Employee Flag Distribution per-day breakdown —
  // independent of expandedUserId (which drives the Daily Breakdown table).
  const [expandedFlagUserId, setExpandedFlagUserId] = useState<string | null>(null);
  // Accordion state for the Flag Frequencies occurrence breakdown — the
  // expanded flag type id, or null when all rows are collapsed.
  const [expandedFlagType, setExpandedFlagType] = useState<string | null>(null);
  // Accordion state for the Daily Reports per-employee breakdown — the
  // expanded user id, or null when all rows are collapsed.
  const [expandedReportUserId, setExpandedReportUserId] = useState<string | null>(null);
  // Per-user resolved work-model definition (drives the Bulk Edit live OT
  // preview in DailyBreakdownTable). Captured during generateReport.
  const [workModelByUser, setWorkModelByUser] = useState<Map<string, WorkModelDef | null>>(new Map());
  // Live Bulk Edit preview totals reported up from DailyBreakdownTable while
  // the admin edits (null = not editing). Direct HH:MM strings, matching the
  // summary object's display format. The employee summary card swaps to these
  // so the totals update dynamically BEFORE the batch save.
  const [liveTotalsByUser, setLiveTotalsByUser] = useState<Map<string, { regularHours: string; overtimeHours: string; doubleTimeHours: string; totalHours: string } | null>>(new Map());
  // Daily Breakdown: merged view always shows the flag chips AND the
  // Reg/OT/DT metric columns computed from the pipeline entries
  // (utils/analyticsFlags.ts).
  const [payrollSettings, setPayrollSettings] = useState({
    payroll_cycle_type: 'biweekly',
    weekly_start_day: 1,
    biweekly_start_date: '2024-01-01',
    monthly_start_day: 1,
    exclude_records_before_date: '',
    // Automated Actions guardrails — drive the open-shift lunch projection
    // policy (under max = actual elapsed; at/over max = recorded cap).
    onsiteLunchMaxMinutes: 120,
    onsiteLunchRecordedMinutes: 60,
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // Work-model definitions loaded at mount so the Remote pay-cycle trigger can
  // resolve Remote-ness via the authoritative workModelId → name lookup (the
  // same precedence as the OT math and the User Base pill) instead of the
  // drift-prone legacy workModel string.
  const [workModels, setWorkModels] = useState<WorkModelDef[]>([]);

  useEffect(() => {
    listWorkModels()
      .then(setWorkModels)
      .catch(e => console.error('Failed to load work models for cycle resolution', e));
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        // Read-through fallback: honors systemSettings/global, falling back to
        // the legacy reminders/payroll docs when global isn't migrated yet.
        const s = await fetchGlobalSettings();
        if (s) {
          setPayrollSettings({
            payroll_cycle_type: s.payroll_cycle_type,
            weekly_start_day: s.weekly_start_day,
            biweekly_start_date: s.biweekly_start_date,
            monthly_start_day: s.monthly_start_day,
            exclude_records_before_date: s.exclude_records_before_date || '',
            onsiteLunchMaxMinutes: s.onsiteLunchMaxMinutes,
            onsiteLunchRecordedMinutes: s.onsiteLunchRecordedMinutes,
          });
        }
      } catch (err) {
        console.error('Failed to load payroll settings', err);
      } finally {
        setSettingsLoaded(true);
      }
    };
    loadSettings();
  }, []);

  const cycleType = payrollSettings.payroll_cycle_type;

  // Stage 2 trigger: a single Remote employee is selected. Only then do the
  // cycle presets switch to that employee's remotePayCalculationDay cycle and
  // the buttons relabel to "Employee's …". Group selections (All / role
  // groups) and On-site employees keep the standard On-Site cycles.
  const remoteCycleUser = useMemo(() => {
    if (isGroupSelection(selectedUserId)) return null;
    const u = allUsers.find(x => x.uid === selectedUserId);
    return u && isRemoteWorkModel(u, workModels) ? u : null;
  }, [selectedUserId, allUsers, workModels]);

  /**
   * Pure helper: compute the start/end YMD strings for a given preset
   * ('current' | 'last') based on the loaded payroll settings.
   *
   * Anchor "today" in PT (America/Los_Angeles): admin payroll cycle
   * boundaries run in PT per AGENTS.md. The previous toISOString() slice
   * anchored to the browser-local UTC day, which can be one calendar day
   * ahead of PT between ~16:00 PST / 17:00 PDT and UTC midnight — landing
   * the Current/Last Cycle presets on the wrong block.
   *
   * Remote trigger: when a single Remote employee is selected, bypass the
   * global cycle settings entirely and compute the custom monthly cycle from
   * that employee's remotePayCalculationDay (src/utils/payCycle.ts).
   */
  const computeCycleDates = useCallback((preset: 'current' | 'last'): { start: string; end: string } => {
    const todayYmd = getCurrentPTDate();

    if (remoteCycleUser) {
      return computeRemotePayCycle(preset, todayYmd, remoteCycleUser.remotePayCalculationDay ?? 1);
    }

    if (cycleType === 'weekly') {
      // Bug fix: was `today.getDay()` (local TZ) — inconsistent for non-UTC users.
      // Now derived from a PT-anchored YMD with UTC math so the week boundary
      // is stable.
      const [ty, tm, td] = todayYmd.split('-').map(Number);
      const day = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay();
      const startDay = payrollSettings.weekly_start_day;
      const diff = day >= startDay ? day - startDay : 7 - (startDay - day);

      const currentStart = new Date(Date.UTC(ty, tm - 1, td - diff));
      const currentEnd = new Date(currentStart);
      currentEnd.setUTCDate(currentStart.getUTCDate() + 6);

      if (preset === 'current') {
        return { start: currentStart.toISOString().slice(0, 10), end: currentEnd.toISOString().slice(0, 10) };
      } else {
        const lastStart = new Date(currentStart);
        lastStart.setUTCDate(lastStart.getUTCDate() - 7);
        const lastEnd = new Date(lastStart);
        lastEnd.setUTCDate(lastStart.getUTCDate() + 6);
        return { start: lastStart.toISOString().slice(0, 10), end: lastEnd.toISOString().slice(0, 10) };
      }
    } else if (cycleType === 'biweekly' || cycleType === 'custom') {
      // Use anchor date to determine current biweekly block
      let anchorStr = payrollSettings.biweekly_start_date;
      if (!anchorStr) anchorStr = '2024-01-01';
      // UTC-anchored to avoid local-TZ drift
      const [ay, am, ad] = anchorStr.split('-').map(Number);
      const anchor = new Date(Date.UTC(ay, am - 1, ad));

      const [ty, tm, td] = todayYmd.split('-').map(Number);
      const todayUtc = new Date(Date.UTC(ty, tm - 1, td));

      const diffTime = todayUtc.getTime() - anchor.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      const cyclesPassed = Math.floor(diffDays / 14);
      const currentStart = new Date(anchor);
      currentStart.setUTCDate(anchor.getUTCDate() + (cyclesPassed * 14));
      const currentEnd = new Date(currentStart);
      currentEnd.setUTCDate(currentStart.getUTCDate() + 13);

      if (preset === 'current') {
        return { start: currentStart.toISOString().slice(0, 10), end: currentEnd.toISOString().slice(0, 10) };
      } else {
        const lastStart = new Date(currentStart);
        lastStart.setUTCDate(lastStart.getUTCDate() - 14);
        const lastEnd = new Date(lastStart);
        lastEnd.setUTCDate(lastStart.getUTCDate() + 13);
        return { start: lastStart.toISOString().slice(0, 10), end: lastEnd.toISOString().slice(0, 10) };
      }
    } else if (cycleType === 'monthly') {
      // Configurable monthly cycle anchored on monthly_start_day (1–28).
      // Previously this hardcoded the 1st of the calendar month using
      // browser-local Date (TZ bug). Now UTC-anchored (matching the weekly/
      // biweekly branches) and derived from the configured start day.
      const startDay = Math.min(28, Math.max(1, payrollSettings.monthly_start_day || 1));
      const [ty, tm, td] = todayYmd.split('-').map(Number);

      // Cycle start = day `startDay` of the month containing today's cycle.
      // If today's day-of-month is before the anchor day, the cycle began
      // in the previous month.
      let startY = ty;
      let startM0 = tm - 1; // 0-indexed
      if (td < startDay) {
        if (startM0 === 0) { startM0 = 11; startY -= 1; }
        else startM0 -= 1;
      }
      const currentStart = new Date(Date.UTC(startY, startM0, startDay));

      // End = one day before the next cycle start (day before next month's
      // anchor day). nextStart uses startM0+1 (normalized by Date.UTC).
      const nextStart = new Date(Date.UTC(startY, startM0 + 1, startDay));
      const currentEnd = new Date(nextStart);
      currentEnd.setUTCDate(nextStart.getUTCDate() - 1);

      if (preset === 'current') {
        return { start: currentStart.toISOString().slice(0, 10), end: currentEnd.toISOString().slice(0, 10) };
      } else {
        // Last cycle = one month before the current cycle.
        let lastStartY = startY;
        let lastStartM0 = startM0 - 1;
        if (lastStartM0 < 0) { lastStartM0 = 11; lastStartY -= 1; }
        const lastStart = new Date(Date.UTC(lastStartY, lastStartM0, startDay));
        const lastEnd = new Date(currentStart);
        lastEnd.setUTCDate(currentStart.getUTCDate() - 1);
        return { start: lastStart.toISOString().slice(0, 10), end: lastEnd.toISOString().slice(0, 10) };
      }
    }
    // Fallback: return today's date for both
    return { start: todayYmd, end: todayYmd };
  }, [cycleType, payrollSettings.weekly_start_day, payrollSettings.biweekly_start_date, payrollSettings.monthly_start_day, remoteCycleUser]);

  const setQuickPeriod = (preset: 'current' | 'last') => {
    const { start, end } = computeCycleDates(preset);
    setStartDate(start);
    setEndDate(end);
  };

  const generateReport = useCallback(async () => {
    if (!startDate || !endDate) {
      toast.error('Please select start and end dates');
      return;
    }

    setLoading(true);
    try {
      // Load work models once for per-user OT rule resolution.
      // (List is small; safe to fetch in full each report run.)
      const workModelList = await listWorkModels();
      const workModelById = new Map<string, WorkModelDef>(workModelList.map(m => [m.id, m]));

      // Pull entries through the Analytics read pipeline (same query shape,
      // exclusion cutoff, segment rebuild, cross-midnight attribution, and
      // role narrowing as Payroll) — EXCEPT completeOnly: false so open /
      // incomplete shifts are included.
      const attributed = await fetchAttributedTimeEntries({
        startDate,
        endDate,
        selectedUserId,
        allUsers,
        completeOnly: false,
        excludeBefore: payrollSettings.exclude_records_before_date,
      });

      // IN-MEMORY virtual closure: open shifts are projected forward to the
      // current moment so their accumulated hours count toward totals and OT.
      // Strictly read-side — nothing here is ever persisted to Firestore.
      // Lunch projection mirrors the autoGuardrails cron: under the max-open
      // threshold the actual elapsed lunch is deducted; at/over it the
      // deduction caps to the recorded minutes.
      const dateAttributedEntries = projectOpenShiftsAt(attributed, Date.now(), {
        lunchMaxMinutes: payrollSettings.onsiteLunchMaxMinutes,
        lunchRecordedMinutes: payrollSettings.onsiteLunchRecordedMinutes,
      });

      // Group by employee and calculate biweekly overtime totals (California rules)
      const byUser = new Map<string, OvertimeEntry[]>();
      dateAttributedEntries.forEach(e => {
        const uid = String(e.userId || '');
        if (!byUser.has(uid)) byUser.set(uid, []);
        byUser.get(uid)!.push(e as OvertimeEntry);
      });

      const summaries: PayrollSummary[] = [];
      const wmByUser = new Map<string, WorkModelDef | null>();
      for (const [userId, entries] of byUser.entries()) {
        const userObj = allUsers.find(u => u.uid === userId);
        const userWorkModel = userObj?.workModelId ? workModelById.get(userObj.workModelId) ?? null : null;
        const userOverride = userObj?.workModelOverride ?? null;
        wmByUser.set(userId, userWorkModel);
        const ot = calculateBiweeklyOvertimeTotals(entries, payrollSettings.weekly_start_day, userWorkModel, userOverride);
        summaries.push({
          userId,
          userName: allUsers.find(u => u.uid === userId)?.name || 'Unknown',
          workModel: userWorkModel?.name || userObj?.workModel || 'On-site',
          // Direct HH:MM outputs calculated from the raw minute totals.
          regularHours: formatMinutesToHHMM(ot.grandTotals.regularMinutes || 0),
          overtimeHours: formatMinutesToHHMM(ot.grandTotals.otMinutes || 0),
          doubleTimeHours: formatMinutesToHHMM(ot.grandTotals.doubleTimeMinutes || 0),
          totalHours: formatMinutesToHHMM(ot.grandTotals.totalMinutes || 0),
          dailyEntries: ot.adjustedEntries.sort((a, b) => b.workDate.localeCompare(a.workDate))
        });
      }

      // Primary: alphabetical. Secondary (stable group pass): on-site above
      // remote. Array.prototype.sort is stable (ES2019+), so a group-only
      // comparator preserves the alphabetical order within each group.
      summaries.sort((a, b) => a.userName.localeCompare(b.userName));
      summaries.sort((a, b) => (a.workModel === 'On-site' ? 0 : 1) - (b.workModel === 'On-site' ? 0 : 1));
      setWorkModelByUser(wmByUser);
      setReport(summaries);
      toast.success('Report generated');
    } catch {
      toast.error('Failed to generate report');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, selectedUserId, allUsers, payrollSettings.weekly_start_day, payrollSettings.exclude_records_before_date, payrollSettings.onsiteLunchMaxMinutes, payrollSettings.onsiteLunchRecordedMinutes]);

  // Auto-initialize dates to Current Cycle on mount (after settings load).
  // The state change re-triggers the debounced auto-refresh effect below,
  // which is the single source of report runs — calling generateReport()
  // directly here too would double-fetch (the setState fires the debounce).
  useEffect(() => {
    if (!settingsLoaded) return;
    const { start, end } = computeCycleDates('current');
    // Defer setState to avoid cascading renders (React ESLint rule).
    setTimeout(() => {
      setStartDate(start);
      setEndDate(end);
    }, 0);
  }, [settingsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stage 2: when the employee filter crosses into/out of the Remote trigger
  // (single Remote employee selected vs. anything else), snap the date range
  // to the newly-active cycle semantics immediately — the employee's custom
  // remotePayCalculationDay cycle entering, the standard On-Site cycle
  // leaving. The debounced effect below then re-runs the report once.
  const prevRemoteUid = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const uid = remoteCycleUser?.uid ?? null;
    if (prevRemoteUid.current === undefined) {
      // First run after mount — the mount effect above already initialized
      // dates; don't double-set.
      prevRemoteUid.current = uid;
      return;
    }
    if (prevRemoteUid.current === uid) return;
    prevRemoteUid.current = uid;
    const { start, end } = computeCycleDates('current');
    setStartDate(start);
    setEndDate(end);
  }, [remoteCycleUser, computeCycleDates]);

  // Debounced auto-refresh: re-run the report whenever any control changes.
  // allUsers is included so a report that ran while the user list was still
  // loading (empty) re-syncs once profiles resolve — otherwise names, work
  // models, and role-group membership stay stale until the next control
  // change or a full page refresh.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitialMount = useRef(true);
  useEffect(() => {
    // Skip the very first render — the mount effect above already handles it.
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (!startDate || !endDate) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      generateReport();
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [startDate, endDate, selectedUserId, allUsers]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportCSV = () => {
    if (!report) return;

    const headers = ['Employee', 'Regular Hours', 'Overtime (1.5x)', 'Double Time (2x)', 'Total Hours'];
    // Values are already direct HH:MM strings from the calculation pipeline.
    const rows = report.map(r => [
      r.userName,
      r.regularHours,
      r.overtimeHours,
      r.doubleTimeHours,
      r.totalHours,
    ]);

    const csvContent = generateCSV(headers, rows);
    downloadCSV(`analytics-report-${startDate}-to-${endDate}`, csvContent);
    toast.success('CSV exported');
  };

  const printReport = () => {
    window.print();
  };

  // Cross-employee totals: aggregate each day's RAW MINUTES (HH:MM strings
  // can't be summed), then format the final sums as HH:MM.
  const totalRegular = formatMinutesToHHMM(
    report?.reduce((acc, r) => acc + (r.dailyEntries ?? []).reduce((s, d) => s + (d.regularMinutes || 0), 0), 0) || 0);
  const totalOvertime = formatMinutesToHHMM(
    report?.reduce((acc, r) => acc + (r.dailyEntries ?? []).reduce((s, d) => s + (d.otMinutes || 0), 0), 0) || 0);
  const totalDouble = formatMinutesToHHMM(
    report?.reduce((acc, r) => acc + (r.dailyEntries ?? []).reduce((s, d) => s + (d.doubleTimeMinutes || 0), 0), 0) || 0);
  const grandTotal = formatMinutesToHHMM(
    report?.reduce((acc, r) => acc + (r.dailyEntries ?? []).reduce((s, d) => s + (d.totalWorkMinutes || 0), 0), 0) || 0);

  // Multi-shift aggregation for the Daily Breakdown table. A day's `segments[]`
  // (if present) holds the individual shifts; the parent row must reflect the
  // day's earliest clock-in, latest clock-out, and aggregated lunch breaks —
  // not the entry-level fields, which may hold the wrong shift's value.
  //
  // Multi-day / cross-midnight handling: segment manual times are stored as
  // "HH:MM" strings with no date. To order them across midnight AND across
  // multiple calendar days we prefer the epoch-ms `clockInSystem` /
  // `clockOutSystem` fields (the true wall-clock instants). The calendar-day
  // offset of each timestamp relative to the shift's clock-in is rendered as a
  // dynamic "+Nd" badge (e.g. +2d for a 48-72h span). Manual-only segments
  // (no system timestamps) fall back to the single-day wrap heuristic and can
  // only detect a +1d boundary.
  interface TimeBoundary {
    time?: string;
    /** Absolute epoch-ms system timestamp for the boundary (when known). Used
     * by the admin timezone view (Req 4) to convert to local/PT for display. */
    ms?: number;
    dayOffset: number; // calendar days after the anchor (0 = same day, 1 = next, 2 = +2d, …)
  }

  const toMinutes = (t: string | undefined | null): number => {
    if (!t) return NaN;
    const parts = String(t).split(':').map(Number);
    if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return NaN;
    return parts[0] * 60 + parts[1];
  };

  // Calendar-day difference between two epoch-ms instants, computed in the
  // DISPLAY zone (the zone the row's times are rendered in — employee local
  // for the 'local' view, PT for the 'pt' view). The badge zone must match
  // the display zone: comparing PT dates while rendering local times produced
  // false-positive +1d badges on same-local-day shifts that merely straddled
  // the PT midnight (e.g. 12:00 AM → 11:59 PM local).
  const dayOffsetFromSystem = (anchorMs: number, targetMs: number, zone: string): number =>
    calendarDayOffsetInZone(anchorMs, targetMs, zone);

  const getDayBoundaries = (day: DocumentData, zone: string): { clockIn?: TimeBoundary; clockOut?: TimeBoundary } => {
    const segs = day.segments;
    if (!Array.isArray(segs) || segs.length === 0) {
      // Legacy single-shift doc.
      const inMs = typeof day.clockInSystem === 'number' ? day.clockInSystem : undefined;
      const outMs = typeof day.clockOutSystem === 'number' ? day.clockOutSystem : undefined;
      let outOffset = 0;
      if (inMs !== undefined && outMs !== undefined) {
        outOffset = dayOffsetFromSystem(inMs, outMs, zone);
      } else {
        const inM = toMinutes(day.clockInManual);
        const outM = toMinutes(day.clockOutManual);
        outOffset = !Number.isNaN(inM) && !Number.isNaN(outM) && outM < inM ? 1 : 0;
      }
      return {
        clockIn: { time: day.clockInManual, ms: inMs, dayOffset: 0 },
        clockOut: { time: day.clockOutManual, ms: outMs, dayOffset: outOffset },
      };
    }
    // Earliest clock-in and latest clock-out across all segments. All
    // candidates are normalized to ONE unit (epoch ms) before comparing:
    // manual-only HH:MM strings are anchored to the row's workDate in the
    // display zone via epochFromLocalWallTime (wrapFrom the clock-in for
    // clock-outs). The previous `inMs ?? inM` mixed epoch-ms (~1.7e12) with
    // minutes-of-day (0–1440) in a single </> comparison, silently dropping
    // manual-only segments from the aggregate In/Out whenever any sibling
    // segment carried a *System timestamp.
    let earliest: { time: string; ms?: number; absMs: number } | null = null;
    let latest: { time: string; ms?: number; absMs: number } | null = null;
    for (const s of segs) {
      const inMs = typeof s.clockInSystem === 'number' ? s.clockInSystem : undefined;
      const inAbsMs = inMs ?? epochFromLocalWallTime(s.clockInManual, day.workDate, zone) ?? NaN;
      if (!Number.isNaN(inAbsMs) && (!earliest || inAbsMs < earliest.absMs)) {
        earliest = { time: s.clockInManual, ms: inMs, absMs: inAbsMs };
      }
      const outMs = typeof s.clockOutSystem === 'number' ? s.clockOutSystem : undefined;
      const outAbsMs =
        outMs ??
        epochFromLocalWallTime(s.clockOutManual, day.workDate, zone, s.clockInManual) ??
        NaN;
      if (!Number.isNaN(outAbsMs) && (!latest || outAbsMs > latest.absMs)) {
        latest = { time: s.clockOutManual, ms: outMs, absMs: outAbsMs };
      }
    }
    // Day offset for the latest clock-out relative to the earliest clock-in —
    // both anchors are epoch ms now, so the same zone-aware calendar
    // comparison covers system, manual, and mixed rows alike.
    const outOffset =
      earliest && latest ? Math.max(0, dayOffsetFromSystem(earliest.absMs, latest.absMs, zone)) : 0;
    return {
      clockIn: earliest ? { time: earliest.time, ms: earliest.ms, dayOffset: 0 } : undefined,
      clockOut: latest ? { time: latest.time, ms: latest.ms, dayOffset: outOffset } : undefined,
    };
  };

  // 3-way lunch summary: 0 breaks → none; 1 break → its times; 2+ → multiple.
  // dayOffset for a break is relative to the owning segment's clock-in.
  const getDayLunch = (day: DocumentData, zone: string): { lunchOut?: TimeBoundary; lunchIn?: TimeBoundary; isMultiple: boolean } => {
    const segs = day.segments;
    if (!Array.isArray(segs) || segs.length === 0) {
      const hasBreak = !!day.lunchOutManual && !!day.lunchInManual;
      if (!hasBreak) return { isMultiple: false };
      const inMs = typeof day.clockInSystem === 'number' ? day.clockInSystem : undefined;
      const loMs = typeof day.lunchOutSystem === 'number' ? day.lunchOutSystem : undefined;
      const liMs = typeof day.lunchInSystem === 'number' ? day.lunchInSystem : undefined;
      const inM = toMinutes(day.clockInManual);
      const loM = toMinutes(day.lunchOutManual);
      const liM = toMinutes(day.lunchInManual);
      const loOffset = inMs !== undefined && loMs !== undefined ? dayOffsetFromSystem(inMs, loMs, zone)
        : (!Number.isNaN(inM) && !Number.isNaN(loM) && loM < inM ? 1 : 0);
      const liOffset = inMs !== undefined && liMs !== undefined ? dayOffsetFromSystem(inMs, liMs, zone)
        : (!Number.isNaN(inM) && !Number.isNaN(liM) && liM < inM ? 1 : 0);
      return {
        lunchOut: { time: day.lunchOutManual, ms: loMs, dayOffset: loOffset },
        lunchIn: { time: day.lunchInManual, ms: liMs, dayOffset: liOffset },
        isMultiple: false,
      };
    }
    const breaks: { lunchOut: TimeBoundary; lunchIn: TimeBoundary }[] = [];
    for (const s of segs) {
      if (s.skipLunch || !s.lunchOutManual || !s.lunchInManual) continue;
      const inMs = typeof s.clockInSystem === 'number' ? s.clockInSystem : undefined;
      const loMs = typeof s.lunchOutSystem === 'number' ? s.lunchOutSystem : undefined;
      const liMs = typeof s.lunchInSystem === 'number' ? s.lunchInSystem : undefined;
      const inM = toMinutes(s.clockInManual);
      const loM = toMinutes(s.lunchOutManual);
      const liM = toMinutes(s.lunchInManual);
      const loOffset = inMs !== undefined && loMs !== undefined ? dayOffsetFromSystem(inMs, loMs, zone)
        : (!Number.isNaN(inM) && !Number.isNaN(loM) && loM < inM ? 1 : 0);
      const liOffset = inMs !== undefined && liMs !== undefined ? dayOffsetFromSystem(inMs, liMs, zone)
        : (!Number.isNaN(inM) && !Number.isNaN(liM) && liM < inM ? 1 : 0);
      breaks.push({
        lunchOut: { time: s.lunchOutManual, ms: loMs, dayOffset: loOffset },
        lunchIn: { time: s.lunchInManual, ms: liMs, dayOffset: liOffset },
      });
    }
    if (breaks.length === 0) return { isMultiple: false };
    if (breaks.length === 1) {
      return { lunchOut: breaks[0].lunchOut, lunchIn: breaks[0].lunchIn, isMultiple: false };
    }
    return { isMultiple: true };
  };

  // Calendar-day offset for a single segment field, relative to that segment's
  // clock-in. Uses system timestamps when present (handles +Nd), else the
  // single-day manual heuristic (0 or 1).
  const segFieldDayOffset = (
    seg: DocumentData,
    field: 'clockOutManual' | 'lunchOutManual' | 'lunchInManual',
    zone: string,
  ): number => {
    const inMs = typeof seg.clockInSystem === 'number' ? seg.clockInSystem : undefined;
    const sysField = field === 'clockOutManual' ? 'clockOutSystem'
      : field === 'lunchOutManual' ? 'lunchOutSystem'
      : 'lunchInSystem';
    const tMs = typeof seg[sysField] === 'number' ? seg[sysField] : undefined;
    if (inMs !== undefined && tMs !== undefined) {
      return Math.max(0, dayOffsetFromSystem(inMs, tMs, zone));
    }
    const inM = toMinutes(seg.clockInManual);
    const t = toMinutes(seg[field]);
    if (Number.isNaN(inM) || Number.isNaN(t)) return 0;
    return t < inM ? 1 : 0;
  };

  const fmtTime = (t: string | undefined): string => {
    if (!t) return '--';
    const [h, m] = t.split(':');
    const hour = parseInt(h, 10);
    if (Number.isNaN(hour)) return '--';
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const dh = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${dh}:${m} ${ampm}`;
  };

  // Resolved work-model definition for a given employee (drives the Bulk Edit
  // live OT preview). Populated during generateReport; falls back to null
  // (CA defaults) when the report hasn't run yet.
  const workModelByIdForUser = (uid: string): WorkModelDef | null =>
    workModelByUser.get(uid) ?? null;

  // Dynamic day-offset badge: "+1d", "+2d", "+3d" … rendered when a timestamp
  // falls on a later calendar day than its shift's clock-in. Used in both the
  // parent summary row and the per-shift sub-rows.
  const DayOffsetBadge = ({ offset }: { offset: number }) => (
    <span className="inline-flex items-center rounded bg-purple-100 px-1 text-xs font-medium leading-none text-purple-700">
      +{offset}d
    </span>
  );
  const fmtBoundary = (b: TimeBoundary | undefined, empTz?: string): JSX.Element => {
    if (!b || !b.time) return <span>--</span>;
    // Admin timezone view (Req 4): when the absolute epoch-ms timestamp is
    // known, render it converted to the selected view zone (employee local or
    // PT). Falls back to the stored manual string for legacy rows without ms.
    const shown = displayTimeForView(b.ms, b.time, timeViewMode, empTz) ?? b.time;
    return (
      <span className="inline-flex items-center gap-1.5 leading-none">
        {fmtTime(shown)}
        {b.dayOffset > 0 && <DayOffsetBadge offset={b.dayOffset} />}
      </span>
    );
  };

  // Live name resolution: userName is baked into the report at generation
  // time, but allUsers may still have been empty then (async load race in
  // App.tsx). Resolve against the live list at render so late-arriving
  // profiles self-heal without a manual refresh; the generated value is the
  // fallback.
  const resolveUserName = useCallback(
    (summary: PayrollSummary): string =>
      allUsers.find(u => u.uid === summary.userId)?.name || summary.userName,
    [allUsers],
  );

  // The full parent-row flag set for one day — the SAME computation the
  // Daily Breakdown renders (child segment flags + day-level + missing_lunch).
  // Extracted so the Flags Statistics summary counts exactly what the table
  // shows (SSOT: utils/analyticsFlags.ts, no separate Metrics-tab mechanics).
  //
  // Live-day handling (projectedOpen): suppress the flags that would be false
  // positives on a still-running day — day-level flags (very_long/short_day
  // are computed from now-projected totals), missing_lunch (the employee may
  // simply not have taken lunch yet), and every flag on the still-open
  // segment (virtually closed at "now", so after_hours/batch/lunch-pattern
  // would evaluate against a synthetic clockOut). Flags from EARLIER
  // completed segments in the same day are genuine and are kept — matching
  // renderSegFlags, which hides flags only on the projectedClosed child row.
  // The "In Progress"/"now" badges are unaffected (they render in the Clock
  // Out column via renderParentBoundary/renderSegBoundary, not Flags).
  const computeDayFlags = (summary: PayrollSummary, day: DocumentData): string[] => {
    const isLiveDay = day.projectedOpen === true;
    const viewZone = zoneForMode(timeViewMode, getEmployeeTimezone(allUsers.find(u => u.uid === summary.userId)?.timezone));
    const lunch = getDayLunch(day, viewZone);
    const isOnsite = summary.workModel === 'On-site';
    // missing_lunch is meaningless while the day is still running.
    const lunchMissing = !isLiveDay && isOnsite && !lunch.isMultiple && !lunch.lunchOut && !lunch.lunchIn;
    const segs = Array.isArray(day.segments) ? day.segments : [];
    const flagSegs: DocumentData[] = segs.length > 0 ? segs : [day];
    const childFlags: string[][] = flagSegs.map((s, i) => {
      // The still-open segment gets no flags. The segment-less fallback
      // (flagSegs === [day]) inherits the day's live marker.
      if (s.projectedClosed === true || (s === day && isLiveDay)) return [];
      return getSegmentFlags(s, {
        isLastSegment: i === flagSegs.length - 1,
        docAutoClosed: day.autoClosed === true,
        docAutoEndedLunch: day.autoEndedLunch === true,
        docAnomaly: day.anomaly_flag === true,
        completedAt: day.completedAt,
        isOnSite: isOnsite,
      });
    });
    if (isLiveDay) {
      // Union of completed segments' flags only — day-level flags skipped.
      return [...new Set(childFlags.flat())];
    }
    return getParentRowFlags(day, childFlags, lunchMissing ? ['missing_lunch'] : []);
  };

  // Flags Statistics — computed from the generated report's pipeline entries.
  // Also produces the per-employee distribution + per-flag-type frequencies
  // for the two tables below; all from the SAME computeDayFlags SSOT.
  const flagStats = useMemo(() => {
    if (!report) return null;
    const recordedEmployees = report.length;
    // "Days" terminology: each dailyEntries row is one employee-day record, so
    // the cards count days, not raw punch entries.
    let recordedDays = 0;
    let flaggedDays = 0;
    let totalFlags = 0;
    const flagTypeCounts = new Map<string, number>();
    // Per-occurrence detail for the Flag Frequencies accordion: every day a
    // flag fired, with the employee + date. Same computeDayFlags SSOT, so
    // ongoing (projectedOpen) days/segments are already excluded.
    const flagOccurrences = new Map<string, { userName: string; date: string; shifts: number }[]>();
    const employeeDist: {
      userId: string;
      userName: string;
      recordedDays: number;
      flaggedDays: number;
      totalFlags: number;
      flagRate: number;
      riskLevel: 'high' | 'medium' | 'low';
    }[] = [];

    for (const summary of report) {
      let empDays = 0;
      let empFlaggedDays = 0;
      let empFlags = 0;
      for (const day of summary.dailyEntries ?? []) {
        empDays += 1;
        const flags = computeDayFlags(summary, day);
        if (flags.length > 0) empFlaggedDays += 1;
        empFlags += flags.length;
        if (flags.length > 0) {
          const shifts = Array.isArray(day.segments) && day.segments.length > 0 ? day.segments.length : 1;
          const occurrence = { userName: resolveUserName(summary), date: String(day.workDate ?? ''), shifts };
          for (const f of flags) {
            flagTypeCounts.set(f, (flagTypeCounts.get(f) ?? 0) + 1);
            const list = flagOccurrences.get(f) ?? [];
            list.push(occurrence);
            flagOccurrences.set(f, list);
          }
        }
      }
      recordedDays += empDays;
      flaggedDays += empFlaggedDays;
      totalFlags += empFlags;
      const flagRate = empDays > 0 ? (empFlaggedDays / empDays) * 100 : 0;
      employeeDist.push({
        userId: summary.userId,
        userName: resolveUserName(summary),
        recordedDays: empDays,
        flaggedDays: empFlaggedDays,
        totalFlags: empFlags,
        flagRate,
        riskLevel: flagRate > 30 ? 'high' : flagRate > 15 ? 'medium' : 'low',
      });
    }

    employeeDist.sort((a, b) => b.flagRate - a.flagRate);
    const flagFrequencies = [...flagTypeCounts.entries()]
      .map(([flag, count]) => ({ flag, count }))
      .sort((a, b) => b.count - a.count);
    // Accordion ordering: primary alphabetical by user name, secondary
    // chronological DESCENDING by date (newest first; YYYY-MM-DD sorts
    // lexicographically, so reversing the comparator flips the order).
    for (const list of flagOccurrences.values()) {
      list.sort((a, b) => a.userName.localeCompare(b.userName) || b.date.localeCompare(a.date));
    }

    return {
      recordedEmployees,
      recordedDays,
      flaggedDays,
      totalFlags,
      flaggedDayRate: recordedDays > 0 ? (flaggedDays / recordedDays) * 100 : 0,
      flagsPerFlaggedDay: flaggedDays > 0 ? totalFlags / flaggedDays : 0,
      employeeDist,
      flagFrequencies,
      flagOccurrences,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, allUsers, timeViewMode, resolveUserName]);

  // Daily Reports section (Phase 2A): per-employee submission stats + the
  // per-shift report rows. Derived from the SAME `report` pipeline output as
  // the rest of the tab, so the setup card's date range + employee filter and
  // the exclusion cutoff already apply — no separate fetch. `workDate` is the
  // employee-local calendar date (AGENTS.md timezone architecture), matching
  // how the Flag Distribution sub-table renders dates. Only REMOTE employees
  // are listed (the Daily Report modal is a Remote-only clock-out feature).
  const dailyReportStats = useMemo(() => {
    if (!report) return null;
    const hasReport = (v: unknown): boolean =>
      typeof v === 'string' && v.trim().length > 0;
    const employees = report
      // Remote-only: classify via the shared workModelId → name SSOT (legacy
      // string fallback), the same precedence used elsewhere on this tab.
      .filter((summary) => {
        const userObj = allUsers.find(u => u.uid === summary.userId);
        return userObj ? isRemoteWorkModel(userObj, workModels) : false;
      })
      .map((summary) => {
        const rows = (summary.dailyEntries ?? [])
          .map((day) => ({
            id: String(day.id ?? day.workDate ?? ''),
            workDate: String(day.workDate ?? ''),
            dailyReport: typeof day.dailyReport === 'string' ? day.dailyReport : '',
          }))
          // Defensive re-sort: generateReport already sorts dailyEntries by
          // workDate descending, but we re-assert here so the sub-table order
          // doesn't silently depend on that upstream invariant.
          .sort((a, b) => b.workDate.localeCompare(a.workDate));
        const submitted = rows.filter((r) => hasReport(r.dailyReport)).length;
        return {
          userId: summary.userId,
          userName: summary.userName,
          submitted,
          total: rows.length,
          rows,
        };
      })
      // Only list employees who actually have shifts in the filtered range.
      .filter((e) => e.total > 0);
    return { employees };
  }, [report, allUsers, workModels]);

  // Render flag chips for the Flags view. Empty flag list → null (clean cell).
  const renderFlagChips = (flags: string[]): JSX.Element | null => {
    if (flags.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1 items-center">
        {flags.map((f) => {
          const sev = FLAG_SEVERITY[f] ?? 'amber';
          const cls =
            sev === 'red' ? 'bg-red-100 text-red-700 border-red-200'
              : sev === 'purple' ? 'bg-purple-100 text-purple-700 border-purple-200'
                : 'bg-amber-100 text-amber-700 border-amber-200';
          return (
            <span key={f} className={`${CHIP_CLASS} text-[10px] font-medium ${cls}`}>
              {FLAG_LABELS[f] ?? f.replace(/_/g, ' ')}
            </span>
          );
        })}
      </div>
    );
  };

  // Open (still-active) shifts included via the in-memory now-projection —
  // surfaced in the UI so admins know those hours are live estimates.
  const openShiftCount = report
    ? report.reduce((n, s) => n + (s.dailyEntries ?? []).filter(d => d.projectedOpen).length, 0)
    : 0;

  return (
    <div className="space-y-4">
      {/* Report Setup Card */}
      <Card className="border-2 border-slate-200 gap-3">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <FileText className="size-5" />
            Analytics Report Setup
            {loading && <span className="text-xs font-normal text-blue-600 animate-pulse ml-2">Refreshing…</span>}
          </CardTitle>
          <div className="flex items-center gap-3">
            {onTimeViewChange && <TimezoneViewToggle mode={timeViewMode} onChange={onTimeViewChange} />}
            <div className="flex items-center gap-1">
              <OvertimeRulesInfo includeOpenShiftsNote />
              <SectionHelp
                title="Analytics"
                description="Generates summary reports regarding accumulated aggregates across cycle nodes."
                sections={[
                  { title: "Setup View", content: "Filter by User and Period thresholds to accumulate total intervals." },
                  { title: "Details Breakdowns", content: "Click 'View Details' on card objects to expand precise timestamp rows grids." },
                  { title: "Cycle Configuration", content: "Admin adjusts defaults cycle types in global System Settings." }
                ]}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
            <div className="space-y-1">
              <Label className="text-xs">Employee</Label>
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {USER_GROUP_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                  <SelectSeparator />
                  {allUsers.map(u => (
                    <SelectItem key={u.uid} value={u.uid}>{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Start Date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-10"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">End Date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-10"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs invisible">Cycle</Label>
              <Button variant="outline" onClick={() => setQuickPeriod('current')} className="w-full h-10 text-xs">
                {remoteCycleUser ? "Employee's Current Cycle" : 'Current On-Site Cycle'}
              </Button>
            </div>
            <div className="space-y-1">
              <Label className="text-xs invisible">Cycle</Label>
              <Button variant="outline" onClick={() => setQuickPeriod('last')} className="w-full h-10 text-xs">
                {remoteCycleUser ? "Employee's Last Cycle" : 'Last On-Site Cycle'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Report Results */}
      {report && (
        <>
          {/* Summary Stats + Actions */}
          <div className="flex flex-row items-center gap-4 w-full">
            <div className="flex-1 grid grid-cols-4 gap-3">
              <Card className="border-2 border-blue-100 bg-gradient-to-br from-white to-blue-50">
                <CardContent className="py-2 px-3.5 [&:last-child]:pb-2">
                  <div className="flex items-center gap-3">
                    <div className="bg-blue-100 p-2.5 rounded-lg">
                      <Clock className="size-5 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-xs text-slate-600">Regular</p>
                      <p className="text-2xl font-bold text-slate-900">{totalRegular}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 border-orange-100 bg-gradient-to-br from-white to-orange-50">
                <CardContent className="py-2 px-3.5 [&:last-child]:pb-2">
                  <div className="flex items-center gap-3">
                    <div className="bg-orange-100 p-2.5 rounded-lg">
                      <TrendingUp className="size-5 text-orange-600" />
                    </div>
                    <div>
                      <p className="text-xs text-slate-600">OT (1.5x)</p>
                      <p className="text-2xl font-bold text-slate-900">{totalOvertime}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 border-red-100 bg-gradient-to-br from-white to-red-50">
                <CardContent className="py-2 px-3.5 [&:last-child]:pb-2">
                  <div className="flex items-center gap-3">
                    <div className="bg-red-100 p-2.5 rounded-lg">
                      <TrendingUp className="size-5 text-red-600" />
                    </div>
                    <div>
                      <p className="text-xs text-slate-600">DT (2x)</p>
                      <p className="text-2xl font-bold text-slate-900">{totalDouble}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 border-green-100 bg-gradient-to-br from-white to-green-50">
                <CardContent className="py-2 px-3.5 [&:last-child]:pb-2">
                  <div className="flex items-center gap-3">
                    <div className="bg-green-100 p-2.5 rounded-lg">
                      <DollarSign className="size-5 text-green-600" />
                    </div>
                    <div>
                      <p className="text-xs text-slate-600">Total</p>
                      <p className="text-2xl font-bold text-slate-900">{grandTotal}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="shrink-0 flex items-center gap-2">
              <Button variant="outline" onClick={printReport} className="h-10">
                <Printer className="size-4 mr-2" />
                Print
              </Button>
              <Button variant="outline" onClick={exportCSV} className="h-10">
                <Download className="size-4 mr-2" />
                Export CSV
              </Button>
            </div>
          </div>

          {/* Open-shift projection notice */}
          {openShiftCount > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <Radio className="size-4 shrink-0" />
              <span>
                {openShiftCount} open shift{openShiftCount === 1 ? '' : 's'} included — hours are projected to the
                current moment (in-memory only; the database is not modified).
              </span>
            </div>
          )}

          {/* Employee Cards - Mobile Friendly */}
          <div className="space-y-2">
            {report.map((summary, idx) => {
              // Employee's local timezone for the Req-4 'local' view mode.
              const empTz = allUsers.find(u => u.uid === summary.userId)?.timezone;
              // The +Nd day-offset badges must be computed in the same zone the
              // times are displayed in, or same-local-day shifts that straddle
              // the PT midnight get a false-positive +1d badge.
              const viewZone = zoneForMode(timeViewMode, empTz);
              const hasOpenShift = (summary.dailyEntries ?? []).some(d => d.projectedOpen);
              // Divider between the on-site and remote groups: rendered once,
              // directly before the first remote employee (only when both
              // groups are present — i.e. the first remote is not at index 0).
              const showDivider = idx > 0 && summary.workModel !== 'On-site' && report[idx - 1].workModel === 'On-site';
              return (
              <Fragment key={summary.userId}>
              {showDivider && <hr className="my-4 border-t border-gray-200" />}
              <Card className="border-2 border-slate-200">
                <CardContent className="py-1 px-2 [&:last-child]:pb-1">
                  <div className="flex flex-row items-center justify-between gap-4 py-1 px-2">
                    {/* Left — employee info. Fixed width (w-[150px], not
                        min-w) so the In Progress badge can never widen the
                        block and shift the Regular/OT/DT boxes to the right;
                        the badge stacks as a third line below the Total text
                        instead of sitting inline with the name. The parent
                        row's items-center keeps the whole block vertically
                        centered against the metric boxes and View Details. */}
                    <div className="flex flex-col shrink-0 w-[150px]">
                      <h3 className="text-sm font-bold text-slate-900 truncate">{resolveUserName(summary)}</h3>
                      <p className="text-xs text-slate-400">Total: {liveTotalsByUser.get(summary.userId)?.totalHours ?? summary.totalHours} hours</p>
                      {hasOpenShift && (
                        // self-start: without it the column flexbox's default
                        // `align-items: stretch` stretches the chip to the
                        // block's full 150px; this shrink-wraps it to the
                        // text (~64px) with the left edge/text position
                        // unchanged.
                        <span className={`mt-0.5 self-start ${CHIP_CLASS} bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px] font-semibold`}>
                          In Progress
                        </span>
                      )}
                    </div>

                    {/* Center — metric boxes. During Bulk Edit these swap to
                        the live preview totals so the admin sees the impact of
                        pending edits before saving. Only the box whose value
                        actually CHANGED gets the amber warning fill; unchanged
                        boxes keep their default background. */}
                    {(() => {
                      const live = liveTotalsByUser.get(summary.userId) ?? null;
                      // HH:MM string comparison — both sides come from the same
                      // pipeline formatter, so !== is an exact change check.
                      const regChanged = !!live && live.regularHours !== summary.regularHours;
                      const otChanged = !!live && live.overtimeHours !== summary.overtimeHours;
                      const dtChanged = !!live && live.doubleTimeHours !== summary.doubleTimeHours;
                      const amberBox = 'bg-amber-100 border-amber-400 ring-1 ring-amber-300';
                      return (
                        <div className="flex-1 grid grid-cols-3 gap-3 items-center">
                          {/* min-w-0 on every cell: grid `1fr` tracks are
                              minmax(auto, 1fr) by default, so overflowing
                              content could otherwise widen a column and shift
                              the other boxes. */}
                          <div className={`min-w-0 py-1.5 px-3 rounded-lg border ${regChanged ? amberBox : 'bg-slate-50 border-slate-200'}`}>
                            <p className="text-xs text-slate-600 mb-0.5">Regular</p>
                            <p className="text-lg font-bold text-slate-900">{live?.regularHours ?? summary.regularHours}</p>
                          </div>
                          <div className={`min-w-0 py-1.5 px-3 rounded-lg border ${otChanged ? amberBox : 'bg-orange-50 border-orange-200'}`}>
                            <p className="text-xs text-orange-700 mb-0.5">OT 1.5x</p>
                            <p className="text-lg font-bold text-orange-700">{live?.overtimeHours ?? summary.overtimeHours}</p>
                          </div>
                          <div className={`min-w-0 py-1.5 px-3 rounded-lg border ${dtChanged ? amberBox : 'bg-red-50 border-red-200'}`}>
                            <p className="text-xs text-red-700 mb-0.5">DT 2x</p>
                            <p className="text-lg font-bold text-red-700">{live?.doubleTimeHours ?? summary.doubleTimeHours}</p>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Right — view details. Fixed width (w-[76px]) so the
                        "View Details" ↔ "Hide Details" label swap can never
                        change the button's rendered width and re-lay-out the
                        flex row — the metric grid stays pixel-stationary. */}
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => setExpandedUserId(expandedUserId === summary.userId ? null : summary.userId)}
                      className="shrink-0 self-center w-[76px] text-center text-xs font-semibold text-indigo-600 hover:underline p-0 h-auto"
                    >
                      {expandedUserId === summary.userId ? 'Hide Details' : 'View Details'}
                    </Button>
                  </div>

                  {expandedUserId === summary.userId && summary.dailyEntries && (
                    <DailyBreakdownTable
                      summary={summary}
                      currentUser={currentUser}
                      employeeTimezone={empTz}
                      workModelDef={workModelByIdForUser(summary.userId)}
                      workModelOverride={allUsers.find(u => u.uid === summary.userId)?.workModelOverride ?? null}
                      onSaved={generateReport}
                      onLiveTotals={(totals) =>
                        setLiveTotalsByUser(prev => {
                          const next = new Map(prev);
                          if (totals) next.set(summary.userId, totals);
                          else next.delete(summary.userId);
                          return next;
                        })
                      }
                      formatDate={(ymd: string) => formatDateShortWithWeekday(ymd)}
                      isMultiShift={(day: DocumentData) => (Array.isArray(day.segments) ? day.segments : []).length > 1}
                      segmentsOf={(day: DocumentData) => (Array.isArray(day.segments) ? day.segments : [])}
                      renderParentBoundary={(day: DocumentData, which: 'in' | 'out') => {
                        const b = getDayBoundaries(day, viewZone);
                        if (which === 'in') return fmtBoundary(b.clockIn, empTz);
                        return day.projectedOpen
                          ? <span className={`${CHIP_CLASS} bg-emerald-100 text-emerald-700 border-emerald-200 text-xs font-semibold`}>In Progress</span>
                          : fmtBoundary(b.clockOut, empTz);
                      }}
                      renderParentLunch={(day: DocumentData, which: 'out' | 'in') => {
                        const lunch = getDayLunch(day, viewZone);
                        const isOnsite = summary.workModel === 'On-site';
                        const lunchMissing = isOnsite && !lunch.isMultiple && !lunch.lunchOut && !lunch.lunchIn;
                        const boundary = which === 'out' ? lunch.lunchOut : lunch.lunchIn;
                        if (lunch.isMultiple) return <span className="italic text-slate-400">Multiple</span>;
                        if (lunchMissing) return <span className={`${CHIP_CLASS} bg-red-100 text-red-700 font-semibold border-red-200`}>--</span>;
                        return fmtBoundary(boundary, empTz);
                      }}
                      renderSegBoundary={(seg: DocumentData, field) => {
                        if (field === 'clockInManual') return fmtBoundary({ time: seg.clockInManual, ms: seg.clockInSystem, dayOffset: 0 }, empTz);
                        if (field === 'clockOutManual') {
                          return seg.projectedClosed
                            ? <span className={`${CHIP_CLASS} bg-emerald-100 text-emerald-700 border-emerald-200 text-xs font-semibold`}>now</span>
                            : fmtBoundary({ time: seg.clockOutManual, ms: seg.clockOutSystem, dayOffset: segFieldDayOffset(seg, 'clockOutManual', viewZone) }, empTz);
                        }
                        const sysField = field === 'lunchOutManual' ? 'lunchOutSystem' : 'lunchInSystem';
                        return fmtBoundary({ time: seg[field], ms: seg[sysField], dayOffset: segFieldDayOffset(seg, field, viewZone) }, empTz);
                      }}
                      renderParentFlags={(day: DocumentData) => renderFlagChips(computeDayFlags(summary, day))}
                      renderSegFlags={(day: DocumentData, index: number) => {
                        const segs = Array.isArray(day.segments) ? day.segments : [];
                        const flagSegs: DocumentData[] = segs.length > 0 ? segs : [day];
                        // Ongoing shift rows get an empty Flags cell — the
                        // segment is only virtually closed at "now"
                        // (projectedClosed), so any flag on it would be a
                        // false positive. Completed segments in the same day
                        // keep their flags.
                        if (flagSegs[index]?.projectedClosed === true) return null;
                        const flags = getSegmentFlags(flagSegs[index] ?? day, {
                          isLastSegment: index === flagSegs.length - 1,
                          docAutoClosed: day.autoClosed === true,
                          docAutoEndedLunch: day.autoEndedLunch === true,
                          docAnomaly: day.anomaly_flag === true,
                          completedAt: day.completedAt,
                          isOnSite: summary.workModel === 'On-site',
                        });
                        return renderFlagChips(flags);
                      }}
                    />
                  )}
                </CardContent>
              </Card>
              </Fragment>
              );
            })}
          </div>

          {/* Section break — identical to the On-site/Remote divider above */}
          {flagStats && <hr className="my-4 border-t border-gray-200" />}

          {/* Flags Statistics — counts the SAME flags the Daily Breakdown
              renders (utils/analyticsFlags.ts pipeline), never the separate
              Metrics-tab mechanics. Zero states render cleanly (0 / 0% / 0.0). */}
          {flagStats && (
            <Card className="border-2 border-slate-200 gap-2">
              <CardHeader className="pt-4 pb-0">
                <CardTitle className="text-base flex items-center gap-2">
                  <Flag className="size-4" />
                  Flags Statistics
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Users className="size-3.5 text-slate-500" />
                      <p className="text-xs text-slate-600">Recorded Employees</p>
                    </div>
                    <p className="text-2xl font-bold text-slate-900">{flagStats.recordedEmployees}</p>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <FileText className="size-3.5 text-slate-500" />
                      <p className="text-xs text-slate-600">Recorded Days</p>
                    </div>
                    <p className="text-2xl font-bold text-slate-900">{flagStats.recordedDays}</p>
                  </div>
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Flag className="size-3.5 text-red-600" />
                      <p className="text-xs text-red-700">Flagged Days</p>
                    </div>
                    <p className="text-2xl font-bold text-red-700">{flagStats.flaggedDays}</p>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Percent className="size-3.5 text-amber-600" />
                      <p className="text-xs text-amber-700">Flagged Day Rate</p>
                    </div>
                    <p className="text-2xl font-bold text-amber-700">{flagStats.flaggedDayRate.toFixed(1)}%</p>
                  </div>
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Flag className="size-3.5 text-purple-600" />
                      <p className="text-xs text-purple-700">Total Flags</p>
                    </div>
                    <p className="text-2xl font-bold text-purple-700">{flagStats.totalFlags}</p>
                  </div>
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Activity className="size-3.5 text-blue-600" />
                      <p className="text-xs text-blue-700">Flags per Flagged Day</p>
                    </div>
                    <p className="text-2xl font-bold text-blue-700">{flagStats.flagsPerFlaggedDay.toFixed(1)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Employee Flag Distribution + Flag Frequencies — same SSOT data as
              the stat cards above (computeDayFlags), rendered in the Metrics
              tab's card idiom but computed entirely from the Analytics pipeline. */}
          {flagStats && flagStats.recordedDays > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Employee Flag Distribution */}
              <Card className="border-2 border-slate-200 gap-2">
                <CardHeader className="pt-4 pb-0">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="size-4" />
                    Employee Flag Distribution
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {flagStats.employeeDist.map((emp) => {
                      const isFlagDistOpen = expandedFlagUserId === emp.userId;
                      const summary = report?.find(s => s.userId === emp.userId);
                      const days = summary?.dailyEntries ?? [];
                      const toggleFlagDist = () =>
                        setExpandedFlagUserId(prev => (prev === emp.userId ? null : emp.userId));
                      return (
                        <div key={emp.userId} className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden">
                          {/* Summary header — static; only the chevron button
                              toggles the accordion (no nested interactives). */}
                          <div className="flex items-center justify-between p-3">
                            <div className="flex-1">
                              <p className="font-semibold text-sm text-slate-900">{emp.userName}</p>
                              <p className="text-xs text-slate-500">
                                {emp.flaggedDays} / {emp.recordedDays} flagged, {emp.totalFlags} total flags
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-lg font-bold text-slate-900">{emp.flagRate.toFixed(1)}%</span>
                              <Badge
                                variant={emp.riskLevel === 'high' ? 'destructive' : emp.riskLevel === 'medium' ? 'default' : 'secondary'}
                                className={`
                                  ${emp.riskLevel === 'high' ? 'bg-red-500' : ''}
                                  ${emp.riskLevel === 'medium' ? 'bg-amber-500' : ''}
                                  ${emp.riskLevel === 'low' ? 'bg-green-500' : ''}
                                `}
                              >
                                {emp.riskLevel}
                              </Badge>
                              <button
                                type="button"
                                aria-label={isFlagDistOpen ? `Collapse daily flags for ${emp.userName}` : `Expand daily flags for ${emp.userName}`}
                                aria-expanded={isFlagDistOpen}
                                onClick={toggleFlagDist}
                                className="inline-flex items-center justify-center size-7 rounded-md border border-slate-300 bg-white text-slate-500 cursor-pointer transition-colors hover:bg-slate-100 hover:text-slate-700"
                              >
                                <ChevronDown
                                  className={`size-4 transition-transform duration-200 ${isFlagDistOpen ? 'rotate-180' : 'rotate-0'}`}
                                />
                              </button>
                            </div>
                          </div>

                          {/* Per-day flag breakdown — flag sets come from the
                              same computeDayFlags SSOT as the Daily Breakdown
                              table, so ongoing (projectedOpen) days and the
                              still-open segment are already excluded. Only
                              days WITH flags are listed. */}
                          {isFlagDistOpen && (
                            <div className="mx-3 mb-3 rounded-lg border border-slate-200 bg-white overflow-hidden">
                              <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-200 bg-slate-100/60">
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Date</span>
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 text-right">Flags</span>
                              </div>
                              <div className="divide-y divide-slate-100">
                                {days.map((day: DocumentData) => ({ day, dayFlags: summary ? computeDayFlags(summary, day) : [] }))
                                  .filter(({ dayFlags }) => dayFlags.length > 0)
                                  .map(({ day, dayFlags }) => {
                                    const segs = Array.isArray(day.segments) ? day.segments : [];
                                    return (
                                      <div key={String(day.id ?? day.workDate)} className="flex items-center justify-between gap-3 px-3 py-1.5">
                                        <span className="text-xs text-slate-600 whitespace-nowrap">
                                          {formatDateShortWithWeekday(String(day.workDate ?? ''))}
                                          {segs.length > 1 && (
                                            <span className="ml-1 text-slate-400">({segs.length} shifts)</span>
                                          )}
                                        </span>
                                        <span className="flex flex-wrap justify-end gap-1">
                                          {dayFlags.map((f) => (
                                            <span
                                              key={f}
                                              className="inline-flex items-center h-4 whitespace-nowrap rounded border px-1.5 leading-none bg-amber-50 text-amber-800 border-amber-200 text-[10px] font-medium"
                                            >
                                              {FLAG_LABELS[f] ?? f.replace(/_/g, ' ')}
                                            </span>
                                          ))}
                                        </span>
                                      </div>
                                    );
                                  })}
                                {emp.flaggedDays === 0 && (
                                  <p className="px-3 py-2 text-xs text-slate-400">No flagged days in this period.</p>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Flag Frequencies */}
              <Card className="border-2 border-slate-200 gap-2">
                <CardHeader className="pt-4 pb-0">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Flag className="size-4" />
                    Flag Frequencies
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {flagStats.flagFrequencies.length === 0 && (
                      <p className="text-sm text-slate-500">No flags in this period.</p>
                    )}
                    {flagStats.flagFrequencies.map((item) => {
                      const isFreqOpen = expandedFlagType === item.flag;
                      const occurrences = flagStats.flagOccurrences.get(item.flag) ?? [];
                      const toggleFreq = () =>
                        setExpandedFlagType(prev => (prev === item.flag ? null : item.flag));
                      return (
                        <div key={item.flag} className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden">
                          {/* Static row — only the chevron button toggles the
                              accordion (no nested/column-wide interactives). */}
                          <div className="flex items-center justify-between p-2">
                            <span className="text-sm font-medium text-slate-700">{FLAG_LABELS[item.flag] ?? item.flag.replace(/_/g, ' ')}</span>
                            <div className="flex items-center gap-2">
                              <div className="w-24 h-2 bg-slate-200 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-amber-500"
                                  style={{ width: `${flagStats.recordedDays > 0 ? (item.count / flagStats.recordedDays) * 100 : 0}%` }}
                                />
                              </div>
                              <span className="text-sm font-bold text-amber-600 min-w-[3rem] text-right">{item.count}</span>
                              <button
                                type="button"
                                aria-label={isFreqOpen ? `Collapse occurrences of ${FLAG_LABELS[item.flag] ?? item.flag}` : `Expand occurrences of ${FLAG_LABELS[item.flag] ?? item.flag}`}
                                aria-expanded={isFreqOpen}
                                onClick={toggleFreq}
                                className="inline-flex items-center justify-center size-7 rounded-md border border-slate-300 bg-white text-slate-500 cursor-pointer transition-colors hover:bg-slate-100 hover:text-slate-700"
                              >
                                <ChevronDown
                                  className={`size-4 transition-transform duration-200 ${isFreqOpen ? 'rotate-180' : 'rotate-0'}`}
                                />
                              </button>
                            </div>
                          </div>

                          {/* Occurrence breakdown — same sub-table idiom as the
                              Employee Flag Distribution accordion. Occurrences
                              come from computeDayFlags, so ongoing
                              (projectedOpen) shifts are already excluded;
                              pre-sorted by user name, then date. */}
                          {isFreqOpen && (
                            <div className="mx-2 mb-2 rounded-lg border border-slate-200 bg-white overflow-hidden">
                              <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-200 bg-slate-100/60">
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">User</span>
                                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 text-right">Date</span>
                              </div>
                              <div className="divide-y divide-slate-100">
                                {occurrences.map((occ, i) => (
                                  <div key={`${occ.userName}-${occ.date}-${i}`} className="flex items-center justify-between gap-3 px-3 py-1.5">
                                    <span className="text-xs font-medium text-slate-700">{occ.userName}</span>
                                    <span className="text-xs text-slate-600 whitespace-nowrap text-right">
                                      {formatDateShortWithWeekday(occ.date)}
                                      {occ.shifts > 1 && (
                                        <span className="ml-1 text-slate-400">({occ.shifts} shifts)</span>
                                      )}
                                    </span>
                                  </div>
                                ))}
                                {occurrences.length === 0 && (
                                  <p className="px-3 py-2 text-xs text-slate-400">No recorded occurrences in this period.</p>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {/* Grand total row */}
                    <div className="flex items-center justify-between p-2 rounded border border-slate-300 bg-slate-100">
                      <span className="text-sm font-semibold text-slate-900">Total</span>
                      <span className="text-sm font-bold text-slate-900 min-w-[3rem] text-right">{flagStats.totalFlags}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Daily Reports (Phase 2A) — per-employee shift-report accordion.
              Mirrors the Employee Flag Distribution card idiom: static summary
              row (name + stats), chevron-toggled inner table of per-shift
              reports. Data comes from the same `report` pipeline output, so
              the setup card's date range + employee filter already apply. */}
          {dailyReportStats && (
            <Card className="border-2 border-slate-200 gap-2">
              <CardHeader className="pt-4 pb-0">
                <CardTitle className="text-base flex items-center gap-2">
                  <ClipboardList className="size-4" />
                  Daily Reports
                  <span className="text-xs font-normal text-slate-400">(Remote employees)</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {dailyReportStats.employees.length === 0 && (
                    <p className="text-sm text-slate-500">No remote employees with shifts in this period.</p>
                  )}
                  {dailyReportStats.employees.map((emp) => {
                    const isReportOpen = expandedReportUserId === emp.userId;
                    const toggleReport = () =>
                      setExpandedReportUserId(prev => (prev === emp.userId ? null : emp.userId));
                    return (
                      <div key={emp.userId} className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden">
                        {/* Summary header — static; only the chevron button
                            toggles the accordion (no nested interactives). */}
                        <div className="flex items-center justify-between p-3">
                          <div className="flex-1">
                            <p className="font-semibold text-sm text-slate-900">{emp.userName}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-600">
                              {emp.submitted} report{emp.submitted === 1 ? '' : 's'} / {emp.total} shift{emp.total === 1 ? '' : 's'}
                            </span>
                            <button
                              type="button"
                              aria-label={isReportOpen ? `Collapse daily reports for ${emp.userName}` : `Expand daily reports for ${emp.userName}`}
                              aria-expanded={isReportOpen}
                              onClick={toggleReport}
                              className="inline-flex items-center justify-center size-7 rounded-md border border-slate-300 bg-white text-slate-500 cursor-pointer transition-colors hover:bg-slate-100 hover:text-slate-700"
                            >
                              <ChevronDown
                                className={`size-4 transition-transform duration-200 ${isReportOpen ? 'rotate-180' : 'rotate-0'}`}
                              />
                            </button>
                          </div>
                        </div>

                        {/* Per-shift report sub-table — dates descending (newest
                            first), matching the rest of the application. Empty /
                            whitespace-only reports render as a muted placeholder. */}
                        {isReportOpen && (
                          <div className="mx-3 mb-3 rounded-lg border border-slate-200 bg-white overflow-hidden">
                            <div className="flex items-center px-3 py-1.5 border-b border-slate-200 bg-slate-100/60">
                              <span className="w-24 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Date</span>
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Daily Report</span>
                            </div>
                            <div className="divide-y divide-slate-100">
                              {emp.rows.map((row) => (
                                <div key={row.id} className="flex items-start px-3 py-1.5">
                                  <span className="w-24 shrink-0 text-xs text-slate-600 whitespace-nowrap">
                                    {formatDateShortWithWeekday(row.workDate)}
                                  </span>
                                  {row.dailyReport.trim().length > 0 ? (
                                    <span className="text-xs text-slate-700 text-left whitespace-pre-wrap break-words min-w-0">
                                      {row.dailyReport}
                                    </span>
                                  ) : (
                                    <span className="text-xs text-slate-400 italic">No report logged</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
