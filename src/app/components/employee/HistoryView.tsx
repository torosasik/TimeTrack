import { useState, useEffect, useCallback } from 'react';
import { User } from '../../lib/auth';
import { TimeEntry, dbService } from '../../lib/database';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { ArrowLeft, AlertTriangle, Clock, Calendar, Target, ChevronLeft, ChevronRight, Filter, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatHoursHMM } from '../../../utils/timeCalculations';

interface HistoryViewProps {
  user: User;
  onBack: () => void;
}

type PeriodFilter = 'this-week' | 'last-week' | 'custom';

/** Get Monday of the current week in the given timezone, as YYYY-MM-DD */
function getWeekBounds(timezone: string, offset: 'this' | 'last'): { start: string; end: string } {
  // Get "now" in the employee's timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayStr = formatter.format(now); // YYYY-MM-DD in employee TZ
  const [y, m, d] = todayStr.split('-').map(Number);
  const today = new Date(y, m - 1, d);

  // JS getDay(): 0=Sun. We want Monday=0.
  const dayOfWeek = today.getDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(today);
  monday.setDate(today.getDate() - daysSinceMonday);

  if (offset === 'last') {
    monday.setDate(monday.getDate() - 7);
  }

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmt = (dt: Date) => {
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
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
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>('this-week');
  const [currentPage, setCurrentPage] = useState(1);
  const entriesPerPage = 10;

  // Custom date range
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [appliedRange, setAppliedRange] = useState<{ start: string; end: string } | null>(null);

  const tz = user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const getDateRange = useCallback((): { start: string; end: string } | null => {
    if (periodFilter === 'this-week') return getWeekBounds(tz, 'this');
    if (periodFilter === 'last-week') return getWeekBounds(tz, 'last');
    if (periodFilter === 'custom') return appliedRange;
    return null;
  }, [periodFilter, tz, appliedRange]);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const range = getDateRange();
      let data: TimeEntry[];
      if (range) {
        console.log(`[History] Querying entries for ${user.uid} from ${range.start} to ${range.end}`);
        data = await dbService.getTimeEntriesForUserInRange(user.uid, range.start, range.end);
      } else {
        // No range (custom not yet applied) — show nothing
        data = [];
      }
      setEntries(data);
    } catch (error: any) {
      const msg = error?.message || error?.code || 'Unknown error';
      console.error('[History] Failed to load history:', error);
      setErrorMessage(`Failed to load history: ${msg}`);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [user.uid, getDateRange]);

  useEffect(() => {
    if (periodFilter !== 'custom') {
      loadHistory();
    }
  }, [periodFilter, loadHistory]);

  // When custom filter is selected but no range applied yet, clear entries
  useEffect(() => {
    if (periodFilter === 'custom' && !appliedRange) {
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

  // Calculate stats from currently-loaded entries
  const totalHours = entries.reduce((acc, e) => acc + (e.totalHours || 0), 0);
  const daysWorked = entries.filter(e => e.complete).length;
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
          <h1 className="text-2xl md:text-3xl font-bold text-foreground">My History</h1>
          <p className="text-sm text-muted-foreground">View your past time entries and total hours worked.</p>
        </div>

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

      {/* Prominent Total Hours Summary Header */}
      {entries.length > 0 && (
        <Card className="border-2 border-indigo-200 bg-gradient-to-r from-indigo-50 via-violet-50 to-indigo-50 shadow-lg rounded-2xl">
          <CardContent className="py-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-xs font-semibold text-indigo-600 uppercase tracking-widest mb-1">
                  Total Hours
                </p>
                <p className="text-4xl md:text-5xl font-black text-indigo-700 tabular-nums leading-none">
                  {formatHoursHMM(totalHours)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">across</p>
                <p className="text-lg font-bold text-slate-700">
                  {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
                </p>
                {rangeLabel && <p className="text-xs text-slate-500 mt-0.5">{rangeLabel}</p>}
              </div>
            </div>
          </CardContent>
        </Card>
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
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
              const hasWarning = !entry.clockOutManual;
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
                        <p className="text-sm font-bold">{formatTime(entry.clockInManual)}</p>
                      </div>
                      <div className="bg-muted/50 p-2.5 rounded border">
                        <p className="text-xs text-muted-foreground mb-1">Clock Out</p>
                        <p className="text-sm font-bold">{formatTime(entry.clockOutManual) || '-'}</p>
                      </div>
                      <div className="bg-muted/50 p-2.5 rounded border">
                        <p className="text-xs text-muted-foreground mb-1">Lunch</p>
                        <p className="text-sm font-bold">{formatLunchDuration(entry)}</p>
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
                    const hasWarning = !entry.clockOutManual;
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
                        <TableCell className="tabular-nums">{formatTime(entry.clockInManual)}</TableCell>
                        <TableCell className="tabular-nums">
                          {entry.skipLunch ? <span className="text-muted-foreground italic">skipped</span> : formatTime(entry.lunchOutManual)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {entry.skipLunch ? <span className="text-muted-foreground italic">skipped</span> : formatTime(entry.lunchInManual)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {hasWarning ? (
                            <div className="flex items-center gap-2 text-red-600">
                              <AlertTriangle className="size-4" />
                              <span className="font-medium">Missing</span>
                            </div>
                          ) : (
                            formatTime(entry.clockOutManual)
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
                            <TableCell className="tabular-nums text-slate-700">{formatTime(seg.clockInManual)}</TableCell>
                            <TableCell className="tabular-nums text-slate-700">
                              {seg.skipLunch ? <span className="italic text-slate-400">skipped</span> : formatTime(seg.lunchOutManual)}
                            </TableCell>
                            <TableCell className="tabular-nums text-slate-700">
                              {seg.skipLunch ? <span className="italic text-slate-400">skipped</span> : formatTime(seg.lunchInManual)}
                            </TableCell>
                            <TableCell className="tabular-nums text-slate-700">{formatTime(seg.clockOutManual) || '—'}</TableCell>
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
    </div>
  );
}