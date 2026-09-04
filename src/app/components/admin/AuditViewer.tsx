import { useState } from 'react';
import { User } from '../../lib/auth';
import { SectionHelp } from '../ui/section-help';
import { TimeEntry, dbService } from '../../lib/database';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../ui/select';
import { Badge } from '../ui/badge';
import { Checkbox } from '../ui/checkbox';
import { toast } from 'sonner';
import { Search, AlertTriangle, Clock, Shield, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { USER_GROUP_OPTIONS, buildUserIdMatcher } from '../../../utils/userSelection';
import { useExclusionCutoff } from '../../hooks/useExclusionCutoff';
import { filterByExclusionCutoff } from '../../../utils/exclusionFilter';
import { type TimeViewMode, zoneForMode, explodeDocsBySegmentLocalDate } from '../../../utils/timeView';

interface AuditViewerProps {
  allUsers: User[];
  /** Admin timezone view (Req 4). 'local' = employee local tz (default), 'pt' = PT. */
  timeViewMode?: TimeViewMode;
}

interface AuditResult {
  entry: TimeEntry;
  userName: string;
  gaps: {
    clockIn?: number;
    lunchOut?: number;
    lunchIn?: number;
    clockOut?: number;
  };
  flags: string[];
}

export function AuditViewer({ allUsers, timeViewMode = 'local' }: AuditViewerProps) {
  const [selectedUserId, setSelectedUserId] = useState<string>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [suspiciousOnly, setSuspiciousOnly] = useState(false);
  const [results, setResults] = useState<AuditResult[]>([]);
  const exclusionCutoff = useExclusionCutoff();
  const [loading, setLoading] = useState(false);

  const loadEntries = async () => {
    if (!startDate || !endDate) {
      toast.error('Please select start and end dates');
      return;
    }

    setLoading(true);
    try {
      const allEntries = await dbService.getAllTimeEntries();
      const matchesUserId = buildUserIdMatcher(selectedUserId, allUsers);
      const scopedEntries = filterByExclusionCutoff(allEntries, exclusionCutoff, e => e.date);
      // Attribute pre-fix cross-midnight split segments to their own local
      // dates (23:32→00:28 → 07/29 23:32→23:59 + 07/30 00:00→00:28) so the
      // Audit tab analyzes each day-portion under the correct date instead of
      // lumping the whole shift under the punch-in day.
      const dateAttributed = explodeDocsBySegmentLocalDate(scopedEntries);
      const filteredEntries = dateAttributed.filter(entry => {
        const inDateRange = entry.date >= startDate && entry.date <= endDate;
        const matchesUser = matchesUserId(entry.userId);
        return inDateRange && matchesUser && !!entry.clockInManual && !!entry.clockOutManual;
      });

      const auditResults: AuditResult[] = filteredEntries.map(entry => {
        const userName = allUsers.find(u => u.uid === entry.userId)?.name || 'Unknown';
        const gaps: AuditResult['gaps'] = {};
        const flags: string[] = [];

        const ptHourAndMinutes = (millis: number): { h: number; m: number } => {
          const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).formatToParts(new Date(millis));
          const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
          const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
          return { h: h === 24 ? 0 : h, m };
        };

        const calculateGap = (manual: string | undefined, systemMillis: number | undefined) => {
          if (!manual || !systemMillis) return undefined;
          const [h, m] = manual.split(':').map(Number);
          const manualMinutes = h * 60 + m;
          const { h: sh, m: sm } = ptHourAndMinutes(systemMillis);
          const systemMinutes = sh * 60 + sm;
          let gap = systemMinutes - manualMinutes;
          // Handle wrap-around (next day submissions)
          if (gap < -720) gap += 1440;
          return gap;
        };

        gaps.clockIn = calculateGap(entry.clockInManual, entry.clockInSystem);
        gaps.lunchOut = calculateGap(entry.lunchOutManual, entry.lunchOutSystem);
        gaps.lunchIn = calculateGap(entry.lunchInManual, entry.lunchInSystem);
        gaps.clockOut = calculateGap(entry.clockOutManual, entry.clockOutSystem);

        // Flag 1: Batch submission (all steps within 5 minutes)
        if (entry.clockInSystem && entry.clockOutSystem) {
          const mins = Math.abs(entry.clockOutSystem - entry.clockInSystem) / (1000 * 60);
          if (mins < 5) flags.push('batch_submission');
        }

        // Flag 2: After-hours completion (>=6pm or <6am), in canonical PT
        if (entry.completedAt) {
          const { h } = ptHourAndMinutes(entry.completedAt);
          if (h >= 18 || h < 6) flags.push('after_hours_submission');
        }

        return {
          entry,
          userName,
          gaps,
          flags,
        };
      });

      const filtered = (suspiciousOnly
        ? auditResults.filter(r => r.flags.length > 0)
        : auditResults
        // Re-sort newest-first after the cross-midnight explosion. The
        // explosion returns a split doc's parts in ASCENDING localDate order
        // (Day 1 then Day 2), which left the earlier date above the later date
        // (07/29 above 07/30). Sort by date descending so the later day-portion
        // lands above the earlier, matching HistoryView / Team.
      ).sort((a, b) => b.entry.date.localeCompare(a.entry.date));

      setResults(filtered);
      toast.success(`Found ${filtered.length} entries`);
    } catch {
      toast.error('Failed to load entries');
    } finally {
      setLoading(false);
    }
  };

  const formatGap = (minutes: number | undefined): string => {
    if (minutes === undefined) return '--';
    const abs = Math.abs(minutes);
    if (abs < 60) return `${abs}m`;
    const hours = Math.floor(abs / 60);
    const mins = abs % 60;
    return `${hours}h ${mins}m`;
  };

  // Format a system timestamp for the selected admin view zone (Req 4):
  // 'local' → the employee's own local timezone, 'pt' → America/Los_Angeles.
  const formatTimestamp = (timestamp: number | undefined, employeeTz?: string): string => {
    if (!timestamp) return '--';
    return new Date(timestamp).toLocaleString('en-US', {
      timeZone: zoneForMode(timeViewMode, employeeTz),
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getFlagLabel = (flag: string): string => {
    const labels: Record<string, string> = {
      batch_submission: 'Batch',
      after_hours_submission: 'After Hours',
    };
    return labels[flag] || flag;
  };

  const suspiciousCount = results.filter(r => r.flags.length > 0).length;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm mb-2">
        <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          Audit Viewer
        </h2>
        <SectionHelp 
          title="Audit Viewer"
          description="Identify inconsistencies, suspicious flags, and manual timestamp gaps."
          sections={[
            { title: "Suspicious Flags", content: "Marks entries having high correction count or anomalous total totals." },
            { title: "Manual Gaps", content: "Highlights discrepancies between absolute punch triggers and safe averages." },
            { title: "Exporting", content: "Use top controls to download periodic discrepancies stream datasets for accountability." }
          ]}
        />
      </div>
      {/* Filters Card */}
      <Card className="border-2 border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="size-4" />
            Audit Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
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
            <div className="flex items-end">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="suspicious"
                  checked={suspiciousOnly}
                  onCheckedChange={(checked) => setSuspiciousOnly(!!checked)}
                />
                <Label htmlFor="suspicious" className="text-xs cursor-pointer">Suspicious Only</Label>
              </div>
            </div>
          </div>

          <Button onClick={loadEntries} disabled={loading} className="w-full h-10 bg-blue-600 hover:bg-blue-700">
            <Search className="size-4 mr-2" />
            {loading ? 'Loading...' : 'Load Entries'}
          </Button>
        </CardContent>
      </Card>

      {/* Summary Stats */}
      {results.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <Card className="border-2 border-blue-100 bg-gradient-to-br from-white to-blue-50">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="bg-blue-100 p-2.5 rounded-lg">
                  <Search className="size-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-xs text-slate-600">Total Entries</p>
                  <p className="text-2xl font-bold text-slate-900">{results.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-2 border-amber-100 bg-gradient-to-br from-white to-amber-50">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="bg-amber-100 p-2.5 rounded-lg">
                  <AlertTriangle className="size-5 text-amber-600" />
                </div>
                <div>
                  <div className="flex items-center gap-1">
                    <p className="text-xs text-slate-600">Suspicious</p>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="size-3 text-slate-400 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs bg-slate-900 text-slate-50 border-slate-800">
                          <p>Suspicious entries include: Edited entries (batch submit), Missing clock-out, Shifts exceeding long-shift threshold.</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <p className="text-2xl font-bold text-slate-900">{suspiciousCount}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Results List */}
      {results.length > 0 ? (
        <div className="space-y-3">
          {results.map((result, index) => {
            // Employee's local timezone for the Req-4 'local' view mode.
            const empTz = allUsers.find(u => u.uid === result.entry.userId)?.timezone;
            return (
            <Card
              key={index}
              className={`border-2 ${result.flags.length > 0 ? 'border-amber-400 bg-amber-50/30' : 'border-slate-200'}`}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="font-semibold text-slate-900">{result.userName}</h3>
                    <p className="text-xs text-slate-500">{result.entry.date}</p>
                  </div>
                  {result.flags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {result.flags.map((flag, i) => (
                        <Badge key={i} variant="destructive" className="text-xs">
                          {getFlagLabel(flag)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  {/* Clock In */}
                  <div className="bg-slate-50 p-2 rounded border border-slate-200">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-slate-600">Clock In</p>
                        <p className="text-sm font-bold text-slate-900">{result.entry.clockInManual}</p>
                        <p className="text-xs text-slate-500">
                          Submitted: {formatTimestamp(result.entry.clockInSystem, empTz)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-slate-600">Gap</p>
                        <div className="flex items-center gap-1 justify-end">
                          <Clock className="size-3 text-slate-600" />
                          <p className="text-sm font-semibold">{formatGap(result.gaps.clockIn)}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Lunch */}
                  {!result.entry.skipLunch && (
                    <div className="bg-slate-50 p-2 rounded border border-slate-200">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-slate-600">Lunch Out/In</p>
                          <p className="text-sm font-bold text-slate-900">
                            {result.entry.lunchOutManual} → {result.entry.lunchInManual}
                          </p>
                          <p className="text-xs text-slate-500">
                            Submitted: {formatTimestamp(result.entry.lunchOutSystem, empTz)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-slate-600">Gaps</p>
                          <p className="text-sm font-semibold">
                            {formatGap(result.gaps.lunchOut)} / {formatGap(result.gaps.lunchIn)}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Clock Out */}
                  <div className="bg-slate-50 p-2 rounded border border-slate-200">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-slate-600">Clock Out</p>
                        <p className="text-sm font-bold text-slate-900">{result.entry.clockOutManual}</p>
                        <p className="text-xs text-slate-500">
                          Submitted: {formatTimestamp(result.entry.clockOutSystem, empTz)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-slate-600">Gap</p>
                        <div className="flex items-center gap-1 justify-end">
                          <Clock className="size-3 text-slate-600" />
                          <p className="text-sm font-semibold">{formatGap(result.gaps.clockOut)}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
      ) : !loading ? (
        <Card className="border-2 border-dashed border-slate-300">
          <CardContent className="py-16 text-center">
            <div className="bg-slate-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Shield className="size-8 text-slate-400" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">No Entries Loaded</h3>
            <p className="text-sm text-slate-500">Select filters and click "Load Entries" to begin audit</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
