import { useState, useEffect, useCallback, useMemo } from 'react';
import { User } from '../../lib/auth';
import { TimeEntry, dbService } from '../../lib/database';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { ArrowLeft, AlertTriangle, Clock, Calendar, Target, Briefcase, ChevronLeft, ChevronRight, Filter, X, Pencil, ClipboardList } from 'lucide-react';
import { toast } from 'sonner';
import { formatHoursHMM, getEmployeeTimezone } from '../../../utils/timeCalculations';
import { displayTimeForView, explodeDocsBySegmentLocalDate } from '../../../utils/timeView';
import { TimeAdjustmentModal } from './TimeAdjustmentModal';
import { DailyReportsEditModal } from './DailyReportsEditModal';
import { listWorkModels, type WorkModel as WorkModelDef } from '../../../services/workModelsService';
import { isRemoteWorkModel } from '../../../utils/workModelUtils';

interface HistoryViewProps {
  user: User;
  onBack: () => void;
}

type PeriodFilter = 'this-week' | 'last-week' | 'custom';

/** Get Monday of the current employee-LOCAL week, as YYYY-MM-DD.
 * The range edges are computed in the employee's local timezone so they match
 * the stored `workDate` values, which are local calendar dates per the
 * local-time-tracking refactor (see .kilo/rules/timezone-enforcement.md). */
function getWeekBounds(offset: 'this' | 'last', timezone?: string): { start: string; end: string } {
  const tz = getEmployeeTimezone(timezone);
  // Get "now" in the employee's local zone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayStr = formatter.format(now); // YYYY-MM-DD in local zone
  const [y, m, d] = todayStr.split('-').map(Number);
  // UTC-anchored Date so getUTCDay() is stable regardless of runtime TZ.
  const todayUtc = new Date(Date.UTC(y, m - 1, d));

  // JS getDay(): 0=Sun. We want Monday=0.
  const dayOfWeek = todayUtc.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(todayUtc);
  monday.setUTCDate(todayUtc.getUTCDate() - daysSinceMonday);

  if (offset === 'last') {
    monday.setUTCDate(monday.getUTCDate() - 7);
  }

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  const fmt = (dt: Date) => {
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };

  return { start: fmt(monday), end: offset === 'this' ? todayStr : fmt(sunday) };
}

function formatDateRange(start: string, end: string): string {
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  return `${s.toLocaleDateString('en-US', opts)} – ${e.toLocaleDateString('en-US', opts)}`;
}

export function HistoryView({ user, onBack }: HistoryViewProps) {
  // Employee's local timezone drives week bounds and all timestamp display
  // (Req 2c). Falls back to the OS zone when the profile has none.
  const employeeTz = useMemo(() => getEmployeeTimezone(user.timezone), [user.timezone]);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>('this-week');
  const [currentPage, setCurrentPage] = useState(1);
  const entriesPerPage = 10;

  // Custom date range
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [appliedRange, setAppliedRange] = useState<{ start: string; end: string } | null>(null);

  // Edit Daily Reports modal (Remote employees only). workModels is loaded so
  // Remote-ness resolves via the authoritative workModelId → name lookup
  // (isRemoteWorkModel SSOT), the same precedence used across the app.
  const [dailyReportsOpen, setDailyReportsOpen] = useState(false);
  const [workModels, setWorkModels] = useState<WorkModelDef[]>([]);
  useEffect(() => {
    listWorkModels()
      .then(setWorkModels)
      .catch(e => console.error('Failed to load work models for daily-reports visibility', e));
  }, []);
  const isRemote = useMemo(() => isRemoteWorkModel(user, workModels), [user, workModels]);

  const getDateRange = useCallback((): { start: string; end: string } | null => {
    if (periodFilter === 'this-week') return getWeekBounds('this', employeeTz);
    if (periodFilter === 'last-week') return getWeekBounds('last', employeeTz);
    if (periodFilter === 'custom') return appliedRange;
    return null;
  }, [periodFilter, appliedRange, employeeTz]);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const range = getDateRange();
      let data: TimeEntry[];
      if (range) {
        console.log(`[History] Querying entries for ${user.uid} from ${range.start} to ${range.end}`);
        data = await dbService.getTimeEntriesForUserInRange(user.uid, range.start, range.end);
        // S3: Hide soft-deleted (voided/archived) docs so they don't render
        // as "Missing/Incomplete" rows alongside the real entry for the same
        // PT date. Legacy docs without a status field default to 'active'
        // in mapEntry, so historical data is preserved.
        data = data.filter((e) => e.status !== 'voided' && e.status !== 'archived');
        // Attribute pre-fix cross-midnight split segments to their own local
        // dates: a 23:32→00:28 shift stored on the 07/29 doc renders as two
        // rows — 23:32→23:59 under 07/29 and 00:00→00:28 under 07/30.
        data = explodeDocsBySegmentLocalDate(data);
        // Restore newest-first order: the explosion emits a pre-fix doc's
        // dates ascending, breaking the workDate-desc order from Firestore.
        // Stable sort keeps segments within a date in chronological order.
        data.sort((a, b) => b.date.localeCompare(a.date));
      } else {
        // No range (custom not yet applied) — show nothing
        data = [];
      }
      setEntries(data);
    } catch (error: unknown) {
      const err = error as { message?: string; code?: string };
      const msg = err?.message || err?.code || 'Unknown error';
      console.error('[History] Failed to load history:', error);
      setErrorMessage(`Failed to load history: ${msg}`);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [user.uid, getDateRange]);

  useEffect(() => {
    if (periodFilter !== 'custom') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadHistory();
    }
  }, [periodFilter, loadHistory]);

  // When custom filter is selected but no range applied yet, clear entries
  useEffect(() => {
    if (periodFilter === 'custom' && !appliedRange) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEntries([]);
      setLoading(false);
    } else if (periodFilter === 'custom' && appliedRange) {
      loadHistory();
    }
  }, [periodFilter, appliedRange, loadHistory]);

  const handleApplyCustom = () => {
    if (!customStart || !customEnd) {
      toast.error('Please select both start and end dates.');
      return;
    }
    if (customEnd < customStart) {
      toast.error('End date cannot be before start date.');
      return;
    }
    // Max 90 days
    const start = new Date(customStart + 'T00:00:00');
    const end = new Date(customEnd + 'T00:00:00');
    const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays > 90) {
      toast.error('Date range cannot exceed 90 days.');
      return;
    }
    setAppliedRange({ start: customStart, end: customEnd });
    setCurrentPage(1);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const formatTime = (timeStr: string | undefined) => {
    if (!timeStr) return '-';
    const [hours, minutes] = timeStr.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${displayHour}:${minutes} ${ampm}`;
  };

  // Req 2c: display a boundary in the employee's LOCAL timezone. Prefer the
  // absolute epoch-ms system timestamp (converted to local), else the stored
  // manual string (which for new entries is already the local wall clock).
  const formatBoundary = (ms: number | undefined, manual: string | undefined): string => {
    const shown = displayTimeForView(ms, manual, 'local', employeeTz);
    return formatTime(shown);
  };

  const formatLunchDuration = (entry: TimeEntry) => {
    if (entry.skipLunch) return 'Skipped';
    if (!entry.lunchOutManual || !entry.lunchInManual) return '-';

    const [outH, outM] = entry.lunchOutManual.split(':').map(Number);
    const [inH, inM] = entry.lunchInManual.split(':').map(Number);
    const totalMinutes = (inH * 60 + inM) - (outH * 60 + outM);

    return `${totalMinutes}m`;
  };

  // Uses shared HH:MM formatter (e.g. 2.63 -> "2:38")
  const formatHoursMinutes = (hours: number) => formatHoursHMM(hours);

  // Compute the day's CLOCK IN / CLOCK OUT boundaries from the segments[].
  // For multi-shift days the parent summary row must show the EARLIEST clock-in
  // and the LATEST clock-out across all shifts, not the entry-level fields
  // (which may hold the wrong shift's value). Segments are sorted ascending by
  // clockInManual (zero-padded "HH:MM" compares chronologically). If the
  // latest segment is still open (no clockOut), isOpen is true so the caller
  // shows the open-clock-out indicator.
  const getDayBoundaries = (entry: TimeEntry): {
    clockIn?: string; clockOut?: string; isOpen: boolean;
    clockInMs?: number; clockOutMs?: number;
  } => {
    const segs = entry.segments;
    if (!segs || segs.length === 0) {
      return {
        clockIn: entry.clockInManual, clockOut: entry.clockOutManual,
        isOpen: !entry.clockOutManual,
        clockInMs: entry.clockInSystem, clockOutMs: entry.clockOutSystem,
      };
    }
    // Sort chronologically by clockIn (string compare works on "HH:MM").
    const sorted = [...segs].sort((a, b) => (a.clockInManual || '').localeCompare(b.clockInManual || ''));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    // Latest clock-out: prefer the epoch timestamp for true chronology.
    let latestClockOut: string | undefined;
    let latestClockOutMs: number | undefined;
    for (const s of sorted) {
      const outMs = typeof s.clockOutSystem === 'number' ? s.clockOutSystem : undefined;
      if (outMs !== undefined) {
        if (latestClockOutMs === undefined || outMs > latestClockOutMs) {
          latestClockOutMs = outMs;
          latestClockOut = s.clockOutManual;
        }
      } else if (s.clockOutManual && (!latestClockOut || s.clockOutManual > latestClockOut)) {
        latestClockOut = s.clockOutManual;
      }
    }
    return {
      clockIn: first?.clockInManual || entry.clockInManual,
      clockOut: latestClockOut,
      isOpen: !last?.clockOutManual,
      clockInMs: typeof first?.clockInSystem === 'number' ? first.clockInSystem : entry.clockInSystem,
      clockOutMs: latestClockOutMs ?? entry.clockOutSystem,
    };
  };

  // Compute the parent summary row's lunch break display across all segments.
  // A "lunch break" is a segment with BOTH lunchOutManual and lunchInManual
  // (a completed break). Segments with skipLunch or a missing half don't count.
  // 3-way display:
  //   - 0 breaks → show '-' (caller renders empty → '-' via formatTime)
  //   - 1 break  → show that break's exact lunchOut / lunchIn
  //   - 2+ breaks → show "Multiple" to signal more than one break period
  const getDayLunchSummary = (entry: TimeEntry): {
    lunchOut?: string;
    lunchIn?: string;
    lunchOutMs?: number;
    lunchInMs?: number;
    isMultiple: boolean;
  } => {
    const segs = entry.segments;
    if (!segs || segs.length === 0) {
      const hasBreak = !!entry.lunchOutManual && !!entry.lunchInManual;
      return {
        lunchOut: hasBreak ? entry.lunchOutManual : undefined,
        lunchIn: hasBreak ? entry.lunchInManual : undefined,
        lunchOutMs: hasBreak ? entry.lunchOutSystem : undefined,
        lunchInMs: hasBreak ? entry.lunchInSystem : undefined,
        isMultiple: false,
      };
    }
    // Collect completed lunch breaks, sorted by lunchOutManual (chronological).
    const breaks = segs
      .filter(s => !s.skipLunch && !!s.lunchOutManual && !!s.lunchInManual)
      .sort((a, b) => (a.lunchOutManual || '').localeCompare(b.lunchOutManual || ''));

    if (breaks.length === 0) {
      return { isMultiple: false };
    }
    if (breaks.length === 1) {
      return {
        lunchOut: breaks[0].lunchOutManual,
        lunchIn: breaks[0].lunchInManual,
        lunchOutMs: breaks[0].lunchOutSystem,
        lunchInMs: breaks[0].lunchInSystem,
        isMultiple: false,
      };
    }
    return { isMultiple: true };
  };

  // Calculate stats from currently-loaded entries
  const totalHours = entries.reduce((acc, e) => acc + (e.totalHours || 0), 0);
  // Days worked = DISTINCT local dates with a completed entry (entries are
  // already exploded by segment localDate above, so a pre-fix cross-midnight
  // shift counts both days; same-date duplicate docs count once).
  const daysWorked = new Set(entries.filter(e => e.complete).map(e => e.workDate ?? e.date)).size;
  // SHIFTS WORKED: count of completed shifts across all segments in the
  // period. A single day with a split shift (2 segments) counts as 2 shifts,
  // matching the segment model in AGENTS.md §2.
  const shiftsWorked = entries.reduce(
    (acc, e) => acc + (e.segments?.filter(s => s.complete).length || (e.complete ? 1 : 0)),
    0,
  );
  const avgDaily = daysWorked > 0 ? totalHours / daysWorked : 0;

  // Pagination
  const totalPages = Math.ceil(entries.length / entriesPerPage);
  const startIndex = (currentPage - 1) * entriesPerPage;
  const endIndex = startIndex + entriesPerPage;
  const paginatedEntries = entries.slice(startIndex, endIndex);

  // Active range label
  const activeRange = getDateRange();
  const rangeLabel = activeRange ? formatDateRange(activeRange.start, activeRange.end) : null;

  const renderPaginationButtons = () => {
    const buttons = [];
    const maxVisible = 5;

    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        buttons.push(
          <Button
            key={i}
            variant={currentPage === i ? 'default' : 'outline'}
            size="sm"
            className="h-9 w-9 p-0"
            onClick={() => setCurrentPage(i)}
          >
            {i}
          </Button>
        );
      }
    } else {
      buttons.push(
        <Button
          key={1}
          variant={currentPage === 1 ? 'default' : 'outline'}
          size="sm"
          className="h-9 w-9 p-0"
          onClick={() => setCurrentPage(1)}
        >
          1
        </Button>
      );

      if (currentPage > 3) {
        buttons.push(<span key="dots1" className="px-2">...</span>);
      }

      for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
        buttons.push(
          <Button
            key={i}
            variant={currentPage === i ? 'default' : 'outline'}
            size="sm"
            className="h-9 w-9 p-0"
            onClick={() => setCurrentPage(i)}
          >
            {i}
          </Button>
        );
      }

      if (currentPage < totalPages - 2) {
        buttons.push(<span key="dots2" className="px-2">...</span>);
      }

      buttons.push(
        <Button
          key={totalPages}
          variant={currentPage === totalPages ? 'default' : 'outline'}
          size="sm"
          className="h-9 w-9 p-0"
          onClick={() => setCurrentPage(totalPages)}
        >
          {totalPages}
        </Button>
      );
    }

    return buttons;
  };

  if (loading) {
    return (
      <div className="p-8 text-center">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent"></div>
        <p className="mt-4 text-muted-foreground">Loading history…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6 pb-6">
      {/* Header with Back Button */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="h-9"
            >
              <ArrowLeft className="size-4 mr-1" />
              Back
            </Button>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-foreground -mt-[3px]">My Work History</h1>
          <p className="text-sm text-muted-foreground">View your past time entries and total hours worked.</p>
        </div>

        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          {/* Edit Daily Reports entry point — Remote employees only. */}
          {isRemote && (
            <Button
              variant="outline"
              onClick={() => setDailyReportsOpen(true)}
              className="h-10 border-indigo-200 text-indigo-700 hover:bg-indigo-50 hover:text-indigo-800"
            >
              <ClipboardList className="size-4 mr-1.5" />
              Edit Daily Reports
            </Button>
          )}

          {/* Quick Edit & Correction Request entry point */}
          <Button
            variant="outline"
            onClick={() => setAdjustmentOpen(true)}
            className="h-10 border-indigo-200 text-indigo-700 hover:bg-indigo-50 hover:text-indigo-800"
          >
            <Pencil className="size-4 mr-1.5" />
            Edit / Request Time Adjustments
          </Button>

          {/* Period Filter Buttons */}
        <div className="flex items-center gap-1.5 bg-indigo-50/50 backdrop-blur-sm border border-indigo-100/50 p-1.5 rounded-xl overflow-x-auto shadow-sm">
          {(['this-week', 'last-week', 'custom'] as PeriodFilter[]).map((filter) => {
            const labels: Record<PeriodFilter, string> = {
              'this-week': 'This Week',
              'last-week': 'Last Week',
              'custom': 'Custom',
            };
            return (
              <Button
                key={filter}
                variant={periodFilter === filter ? 'default' : 'ghost'}
                size="sm"
                onClick={() => {
                  setPeriodFilter(filter);
                  setCurrentPage(1);
                  if (filter !== 'custom') {
                    setAppliedRange(null);
                  }
                }}
                className={`whitespace-nowrap text-xs md:text-sm h-10 md:h-9 rounded-lg transition-all ${periodFilter === filter ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:text-indigo-700 hover:bg-white/60'}`}
              >
                {labels[filter]}
              </Button>
            );
          })}
        </div>
        </div>
      </div>

      {/* Custom Date Range Picker */}
      {periodFilter === 'custom' && (
        <Card className="border border-indigo-200 shadow-lg bg-indigo-50/30 backdrop-blur-xl rounded-2xl">
          <CardContent className="pt-5 pb-5">
            <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
              <div className="flex-1 min-w-0">
                <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1.5 block">Start Date</Label>
                <Input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="h-11 bg-white/80 border-indigo-200 rounded-xl font-medium"
                />
              </div>
              <div className="flex-1 min-w-0">
                <Label className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1.5 block">End Date</Label>
                <Input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="h-11 bg-white/80 border-indigo-200 rounded-xl font-medium"
                />
              </div>
              <Button
                onClick={handleApplyCustom}
                className="h-11 px-6 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold shadow-md shadow-indigo-200 transition-all"
              >
                <Filter className="size-4 mr-2" />
                Apply
              </Button>
              {appliedRange && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAppliedRange(null);
                    setCustomStart('');
                    setCustomEnd('');
                    setEntries([]);
                  }}
                  className="h-11 text-slate-500 hover:text-red-600"
                >
                  <X className="size-4" />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Active Filter Label */}
      {rangeLabel && (
        <div className="flex items-center gap-2 text-sm font-medium text-indigo-700 bg-indigo-50/60 border border-indigo-100 rounded-xl px-4 py-2.5">
          <Calendar className="size-4" />
          <span>Showing: {rangeLabel}</span>
        </div>
      )}

      {/* Error Banner */}
      {errorMessage && (
        <Card className="border-2 border-red-200 bg-red-50/70 rounded-2xl">
          <CardContent className="py-4">
            <div className="flex items-center gap-3 text-red-700">
              <AlertTriangle className="size-5 shrink-0" />
              <p className="text-sm font-medium">{errorMessage}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={loadHistory}
              className="mt-3 text-red-700 border-red-300 hover:bg-red-100"
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl">
          <CardContent className="pt-4 md:pt-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="bg-gradient-to-tr from-indigo-500 to-violet-400 p-2 md:p-2.5 rounded-xl shadow-sm">
                <Clock className="size-4 md:size-5 text-white" />
              </div>
              <span className="text-xs md:text-sm font-semibold text-slate-500 uppercase tracking-wider">Total Hours</span>
            </div>
            <p className="text-2xl md:text-3xl font-black text-slate-800 tracking-tight">{formatHoursMinutes(totalHours)}</p>
          </CardContent>
        </Card>

        <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl">
          <CardContent className="pt-4 md:pt-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="bg-gradient-to-tr from-emerald-500 to-teal-400 p-2 md:p-2.5 rounded-xl shadow-sm">
                <Calendar className="size-4 md:size-5 text-white" />
              </div>
              <span className="text-xs md:text-sm font-semibold text-slate-500 uppercase tracking-wider">Days Worked</span>
            </div>
            <p className="text-2xl md:text-3xl font-black text-slate-800 tracking-tight">{daysWorked}</p>
          </CardContent>
        </Card>

        <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl">
          <CardContent className="pt-4 md:pt-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="bg-gradient-to-tr from-sky-500 to-blue-400 p-2 md:p-2.5 rounded-xl shadow-sm">
                <Briefcase className="size-4 md:size-5 text-white" />
              </div>
              <span className="text-xs md:text-sm font-semibold text-slate-500 uppercase tracking-wider">Shifts Worked</span>
            </div>
            <p className="text-2xl md:text-3xl font-black text-slate-800 tracking-tight">{shiftsWorked}</p>
          </CardContent>
        </Card>

        <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl">
          <CardContent className="pt-4 md:pt-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="bg-gradient-to-tr from-amber-500 to-orange-400 p-2 md:p-2.5 rounded-xl shadow-sm">
                <Target className="size-4 md:size-5 text-white" />
              </div>
              <span className="text-xs md:text-sm font-semibold text-slate-500 uppercase tracking-wider">Avg. Daily</span>
            </div>
            <p className="text-2xl md:text-3xl font-black text-slate-800 tracking-tight">{formatHoursMinutes(avgDaily)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Entries - Mobile Cards / Desktop Table */}
      {!errorMessage && paginatedEntries.length === 0 ? (
        <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl">
          <CardContent className="py-16 text-center">
            <Clock className="size-16 text-indigo-300 mx-auto mb-4 drop-shadow-sm" />
            <p className="text-lg font-medium text-slate-500">
              {periodFilter === 'custom' && !appliedRange
                ? 'Select a date range and click Apply to view entries.'
                : 'No time entries found for this period.'}
            </p>
          </CardContent>
        </Card>
      ) : !errorMessage && (
        <>
          {/* Mobile Card View */}
          <div className="md:hidden space-y-3">
            {paginatedEntries.map((entry) => {
              const boundaries = getDayBoundaries(entry);
              const lunch = getDayLunchSummary(entry);
              const hasWarning = boundaries.isOpen || !entry.clockOutManual;
              const hasFlags = entry.flags && entry.flags.length > 0;

              return (
                <Card key={entry.id} className="border-2">
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="font-semibold text-base">{formatDate(entry.date)}</p>
                        {hasWarning && (
                          <div className="flex items-center gap-1 text-red-600 mt-1">
                            <AlertTriangle className="size-4" />
                            <span className="text-xs font-medium">Missing Clock Out</span>
                          </div>
                        )}
                      </div>
                      {entry.totalHours ? (
                        <div className="text-right">
                          <p className="text-xl font-bold text-primary">{formatHoursMinutes(entry.totalHours)}</p>
                          <p className="text-xs text-muted-foreground">total</p>
                        </div>
                      ) : (
                        <Badge variant="destructive" className="text-xs">Incomplete</Badge>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <div className="bg-muted/50 p-2.5 rounded border">
                        <p className="text-xs text-muted-foreground mb-1">Clock In</p>
                        <p className="text-sm font-bold">{formatBoundary(boundaries.clockInMs, boundaries.clockIn)}</p>
                      </div>
                      <div className="bg-muted/50 p-2.5 rounded border">
                        <p className="text-xs text-muted-foreground mb-1">Clock Out</p>
                        <p className="text-sm font-bold">{hasWarning ? '—' : (formatBoundary(boundaries.clockOutMs, boundaries.clockOut) || '-')}</p>
                      </div>
                      <div className="bg-muted/50 p-2.5 rounded border">
                        <p className="text-xs text-muted-foreground mb-1">Lunch</p>
                        <p className="text-sm font-bold">
                          {lunch.isMultiple ? (
                            'Multiple breaks'
                          ) : lunch.lunchOut && lunch.lunchIn ? (
                            formatLunchDuration({ ...entry, lunchOutManual: lunch.lunchOut, lunchInManual: lunch.lunchIn } as TimeEntry)
                          ) : (
                            '-'
                          )}
                        </p>
                      </div>
                      <div className="bg-muted/50 p-2.5 rounded border">
                        <p className="text-xs text-muted-foreground mb-1">Status</p>
                        {hasFlags ? (
                          <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-800 border-amber-300">
                            {entry.flags![0]}
                          </Badge>
                        ) : (
                          <p className="text-sm font-bold text-green-600">OK</p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Desktop Table View */}
          <Card className="hidden md:block border border-white/60 shadow-2xl bg-white/70 backdrop-blur-xl rounded-2xl overflow-hidden">
            <div className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>DATE</TableHead>
                    <TableHead>CLOCK IN</TableHead>
                    <TableHead>LUNCH OUT</TableHead>
                    <TableHead>LUNCH IN</TableHead>
                    <TableHead>CLOCK OUT</TableHead>
                    <TableHead>NOTES</TableHead>
                    <TableHead className="text-right">TOTAL HOURS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedEntries.map((entry) => {
                    const boundaries = getDayBoundaries(entry);
                    const lunch = getDayLunchSummary(entry);
                    const hasWarning = boundaries.isOpen || !entry.clockOutManual;
                    const hasFlags = entry.flags && entry.flags.length > 0;
                    const segs = entry.segments || [];
                    const isSplit = segs.length > 1;

                    const rows: JSX.Element[] = [
                      <TableRow key={entry.id} className="hover:bg-muted/30">
                        <TableCell className="font-medium">
                          {formatDate(entry.date)}
                          {isSplit && (
                            <Badge variant="secondary" className="ml-2 text-[10px] bg-indigo-100 text-indigo-700 border-indigo-200">
                              {segs.length} shifts
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">{formatBoundary(boundaries.clockInMs, boundaries.clockIn)}</TableCell>
                        <TableCell className="tabular-nums">
                          {lunch.isMultiple ? (
                            <span className="text-muted-foreground italic">Multiple</span>
                          ) : lunch.lunchOut ? (
                            formatBoundary(lunch.lunchOutMs, lunch.lunchOut)
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {lunch.isMultiple ? (
                            <span className="text-muted-foreground italic">Multiple</span>
                          ) : lunch.lunchIn ? (
                            formatBoundary(lunch.lunchInMs, lunch.lunchIn)
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {hasWarning ? (
                            <div className="flex items-center gap-2 text-red-600">
                              <AlertTriangle className="size-4" />
                              <span className="font-medium">Missing</span>
                            </div>
                          ) : (
                            formatBoundary(boundaries.clockOutMs, boundaries.clockOut)
                          )}
                        </TableCell>
                        <TableCell>
                          {hasWarning ? (
                            <Badge variant="destructive" className="text-xs">
                              Action Required
                            </Badge>
                          ) : hasFlags ? (
                            <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-800 border-amber-300">
                              {entry.flags![0]}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {entry.totalHours ? (
                            <span className="font-semibold text-primary">
                              {formatHoursMinutes(entry.totalHours)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Incomplete</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ];

                    // Split-shift sub-rows
                    if (isSplit) {
                      segs.forEach((seg, i) => {
                        rows.push(
                          <TableRow key={`${entry.id}-seg-${i}`} className="bg-slate-50/60 text-xs">
                            <TableCell className="pl-10 text-slate-500">↳ Shift {i + 1}</TableCell>
                            <TableCell className="tabular-nums text-slate-700">{formatBoundary(seg.clockInSystem, seg.clockInManual)}</TableCell>
                            <TableCell className="tabular-nums text-slate-700">
                              {seg.skipLunch ? <span className="italic text-slate-400">skipped</span> : formatBoundary(seg.lunchOutSystem, seg.lunchOutManual)}
                            </TableCell>
                            <TableCell className="tabular-nums text-slate-700">
                              {seg.skipLunch ? <span className="italic text-slate-400">skipped</span> : formatBoundary(seg.lunchInSystem, seg.lunchInManual)}
                            </TableCell>
                            <TableCell className="tabular-nums text-slate-700">{formatBoundary(seg.clockOutSystem, seg.clockOutManual) || '—'}</TableCell>
                            <TableCell className="text-slate-400">
                              {seg.autoClosed ? (
                                <Badge variant="secondary" className="text-[10px] bg-amber-100 text-amber-800 border-amber-300">auto-closed</Badge>
                              ) : '—'}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-slate-700">
                              {formatHoursMinutes((seg.workMinutes || 0) / 60)}
                            </TableCell>
                          </TableRow>
                        );
                      });
                    }
                    return rows;
                  })}
                </TableBody>
              </Table>
            </div>
          </Card>
        </>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1.5 md:gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-9 p-0"
            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
            disabled={currentPage === 1}
          >
            <ChevronLeft className="size-4" />
          </Button>

          <div className="flex items-center gap-1 md:gap-1.5">
            {renderPaginationButtons()}
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-9 w-9 p-0"
            onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
            disabled={currentPage === totalPages}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      <TimeAdjustmentModal
        user={user}
        open={adjustmentOpen}
        onClose={() => setAdjustmentOpen(false)}
        onSaved={loadHistory}
      />

      {/* Edit Daily Reports modal — rendered only for Remote employees (the
          trigger button is hidden otherwise), so no extra role check here. */}
      {isRemote && (
        <DailyReportsEditModal
          user={user}
          open={dailyReportsOpen}
          onClose={() => setDailyReportsOpen(false)}
        />
      )}
    </div>
  );
}