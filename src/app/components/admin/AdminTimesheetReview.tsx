import { useState } from 'react';
import { User } from '../../lib/auth';
import { dbService, TimeEntry, getActiveSegment, getEntryTotals } from '../../lib/database';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Badge } from '../ui/badge';
import { toast } from 'sonner';
import { Calendar, Download, RefreshCw, Edit } from 'lucide-react';
import { generateCSV, downloadCSV } from '../../../services/exportService';
import { USER_GROUP_OPTIONS, buildUserIdMatcher } from '../../../utils/userSelection';
import { useExclusionCutoff } from '../../hooks/useExclusionCutoff';
import { filterByExclusionCutoff } from '../../../utils/exclusionFilter';

interface AdminTimesheetReviewProps {
  allUsers: User[];
  onCorrectEntry?: (userId: string, dateStr: string) => void; // parent opens existing correction dialog
}

/** Entry row enriched for this view. `correctionNotes` is a raw Firestore field
 *  some legacy docs carry; mapEntry normally folds it into `adminNotes`, but the
 *  checks below preserve the historical runtime behavior of reading it. */
type ReviewEntry = TimeEntry & { userName: string; correctionNotes?: string };

/**
 * Weekly timesheet review surface for admins/managers.
 * Phase 1 deliverable — supports filters, status visibility, correction action, and weekly CSV export.
 * America/Los_Angeles logical dates throughout.
 * Never hard-deletes; only reads existing timeEntries.
 */
export function AdminTimesheetReview({ allUsers, onCorrectEntry }: AdminTimesheetReviewProps) {
  // Default to last 7 days (America/Los_Angeles sense), computed lazily so the
  // mount effect is unnecessary. Local date arithmetic treated as PT logical
  // day strings (matches existing patterns).
  const computeDefaultRange = () => {
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const startD = new Date(today);
    startD.setDate(startD.getDate() - 6);
    const start = startD.toISOString().slice(0, 10);
    return { start, end };
  };

  const [startDate, setStartDate] = useState(() => computeDefaultRange().start);
  const [endDate, setEndDate] = useState(() => computeDefaultRange().end);
  const [selectedUserId, setSelectedUserId] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'corrected' | 'incomplete'>('all');
  const [entries, setEntries] = useState<ReviewEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const exclusionCutoff = useExclusionCutoff();

  const setDefaultRange = () => {
    const { start, end } = computeDefaultRange();
    setStartDate(start);
    setEndDate(end);
  };

  const loadTimesheetData = async () => {
    if (!startDate || !endDate) {
      toast.error('Select a date range');
      return;
    }

    setLoading(true);
    try {
      const all = await dbService.getAllTimeEntries();
      const matchesUser = buildUserIdMatcher(selectedUserId, allUsers);
      const filtered = filterByExclusionCutoff(all, exclusionCutoff, e => e.date)
        .filter(e => e.date >= startDate && e.date <= endDate)
        .filter(e => matchesUser(e.userId));

      // Attach denormalized user name for display
      const withNames: ReviewEntry[] = filtered.map(e => ({
        ...e,
        userName: allUsers.find(u => u.uid === e.userId)?.name || 'Unknown',
        // Treat status field; default to active for legacy rows
        status: e.status || 'active',
      }));

      // Client-side status filter
      const statusFiltered = statusFilter === 'all'
        ? withNames
        : withNames.filter(e => {
            if (statusFilter === 'corrected') return e.status === 'corrected' || !!e.correctionNotes;
            if (statusFilter === 'incomplete') return !e.clockOutManual && !e.complete;
            return true;
          });

      setEntries(statusFiltered);
      toast.success(`Loaded ${statusFiltered.length} entries`);
    } catch {
      toast.error('Failed to load timesheet data');
    } finally {
      setLoading(false);
    }
  };

  const exportWeeklyCSV = () => {
    if (entries.length === 0) {
      toast.error('No rows to export');
      return;
    }

    const headers = ['Date', 'Employee', 'Clock In', 'Clock Out', 'Hours', 'Status', 'Flags'];
    const rows = entries.map(e => {
      const hrs = getEntryTotals(e).totalHours;
      const status = e.status || (e.correctionNotes ? 'corrected' : 'active');
      return [
        e.date,
        e.userName,
        e.clockInManual || '',
        e.clockOutManual || '',
        hrs.toFixed(2),
        status,
        (e.flags || []).join('; '),
      ];
    });

    const csv = generateCSV(headers, rows);
    const filename = `admin-weekly-timesheet-${startDate}-to-${endDate}`;
    downloadCSV(filename, csv);
    toast.success('Weekly timesheet CSV exported (new format, does not affect payroll export)');
  };

  const triggerCorrection = (entry: TimeEntry & { userName: string }) => {
    if (onCorrectEntry) {
      onCorrectEntry(entry.userId, entry.date);
    } else {
      // Fallback: inform operator that main admin correction dialog should be opened
      toast.info(`Open "Correct Entry" and select ${entry.userName} / ${entry.date}`);
    }
  };

  const totalHours = entries.reduce((sum, e) => sum + getEntryTotals(e).totalHours, 0);
  const correctedCount = entries.filter(e => e.status === 'corrected' || !!e.correctionNotes).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="size-5 text-indigo-600" />
          <h2 className="text-xl font-bold">Weekly Timesheet Review</h2>
          <Badge variant="outline" className="ml-2">Admin / Manager</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={setDefaultRange}>
            Last 7 Days
          </Button>
          <Button variant="outline" size="sm" onClick={loadTimesheetData} disabled={loading}>
            <RefreshCw className="size-4 mr-1" /> Refresh
          </Button>
          <Button size="sm" onClick={exportWeeklyCSV} disabled={entries.length === 0}>
            <Download className="size-4 mr-1" /> Export Weekly CSV
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="border border-slate-200">
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div>
              <Label className="text-xs">Start Date</Label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-9" />
            </div>
            <div>
              <Label className="text-xs">End Date</Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="h-9" />
            </div>
            <div>
              <Label className="text-xs">Employee</Label>
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
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
            <div>
              <Label className="text-xs">Status</Label>
              <Select value={statusFilter} onValueChange={(v: string) => setStatusFilter(v as typeof statusFilter)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="active">Active (no corrections)</SelectItem>
                  <SelectItem value="corrected">Corrected</SelectItem>
                  <SelectItem value="incomplete">Incomplete (no clock out)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button onClick={loadTimesheetData} disabled={loading} className="w-full h-9">Apply Filters</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      <div className="flex gap-4 text-sm">
        <div className="rounded-lg bg-indigo-50 px-3 py-1 border border-indigo-100">
          <span className="font-semibold">{entries.length}</span> days shown
        </div>
        <div className="rounded-lg bg-orange-50 px-3 py-1 border border-orange-100">
          <span className="font-semibold">{correctedCount}</span> corrections in range
        </div>
        <div className="rounded-lg bg-emerald-50 px-3 py-1 border border-emerald-100">
          <span className="font-semibold">{totalHours.toFixed(2)}</span> total hours
        </div>
      </div>

      {/* Data Table */}
      <Card className="border border-slate-200">
        <CardHeader><CardTitle className="text-base">Timesheet Rows</CardTitle></CardHeader>
        <CardContent className="p-0">
          {entries.length === 0 && !loading && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No matching entries. Adjust filters and click Refresh.
            </div>
          )}
          {entries.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>In</TableHead>
                  <TableHead>Out</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.sort((a, b) => b.date.localeCompare(a.date)).map(entry => {
                  const hrs = getEntryTotals(entry).totalHours;
                  const isCorrected = !!entry.correctionNotes || entry.status === 'corrected';
                  const isOpen = getActiveSegment(entry) !== null && !entry.clockOutManual;
                  return (
                    <TableRow key={entry.id} className={isCorrected ? 'bg-amber-50/40' : ''}>
                      <TableCell className="font-mono text-sm">{entry.date}</TableCell>
                      <TableCell className="font-medium">{entry.userName}</TableCell>
                      <TableCell className="text-emerald-700 font-mono text-sm">{entry.clockInManual || '—'}</TableCell>
                      <TableCell className="text-rose-700 font-mono text-sm">{entry.clockOutManual || '—'}</TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">{hrs.toFixed(2)}</TableCell>
                      <TableCell>
                        {isCorrected ? (
                          <Badge variant="secondary" className="bg-amber-100 text-amber-800">Corrected</Badge>
                        ) : isOpen ? (
                          <Badge variant="outline" className="border-emerald-400 text-emerald-700">Open</Badge>
                        ) : (
                          <Badge variant="outline">Active</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => triggerCorrection(entry)}
                        >
                          <Edit className="size-4 mr-1" /> Correct
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="text-[11px] text-muted-foreground">
        Data is live from Firestore • All dates in America/Los_Angeles logical work day • Corrections write an immutable audit trail (see auditLogService).
      </div>
    </div>
  );
}
