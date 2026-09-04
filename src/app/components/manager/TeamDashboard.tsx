import { useState, useEffect, useMemo } from 'react';
import { User } from '../../lib/auth';
import { SectionHelp } from '../ui/section-help';
import { TimeEntry, dbService, buildConsistentClosePatch, recomputeSegmentSystemTimestamps, stripUndefined, getEntryTotals, getPreservedSegmentsForEdit, computeSegmentWorkMinutes } from '../../lib/database';
import { doc, updateDoc, Timestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { auditLogService } from '../../../services/auditLogService';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '../ui/select';
import { Badge } from '../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { UserAvatar } from '../ui/user-avatar';
import { StatusDot } from '../ui/status-dot';
import { EmptyState } from '../ui/empty-state';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import { calculateLunchMinutes, validateTimeEntry } from '../../../utils/timeCalculations';
import { calculateDailyOvertimeBreakdown, getWorkWeekStartDate, DEFAULT_WORKWEEK_START_DAY } from '../../../utils/overtimeCalculations';
import { listWorkModels, type WorkModel as WorkModelDef } from '../../../services/workModelsService';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { toast } from 'sonner';
import { Download, Printer, RefreshCw, Eye, Users, AlertTriangle, Calendar, Clock, Filter, LogIn, LogOut, Coffee, MoreVertical, Edit, Trash2 } from 'lucide-react';
import { USER_GROUP_OPTIONS, buildUserIdMatcher } from '../../../utils/userSelection';
import { useExclusionCutoff } from '../../hooks/useExclusionCutoff';
import { filterByExclusionCutoff } from '../../../utils/exclusionFilter';
import { type TimeViewMode, displayTimeForView, explodeDocsBySegmentLocalDate } from '../../../utils/timeView';

interface TeamDashboardProps {
  user: User;
  allUsers: User[];
  /** Admin/Manager timezone view (Req 4). 'local' = employee local tz (default), 'pt' = PT. */
  timeViewMode?: TimeViewMode;
}

export function TeamDashboard({ user, allUsers, timeViewMode = 'local' }: TeamDashboardProps) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [, setLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState<string>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [selectedEntry, setSelectedEntry] = useState<TimeEntry | null>(null);
  const exclusionCutoff = useExclusionCutoff();
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Edit Entry State
  const [editEntryOpen, setEditEntryOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<Partial<TimeEntry> | null>(null);
  const [originalEditingEntry, setOriginalEditingEntry] = useState<TimeEntry | null>(null);
  const [adminNotes, setAdminNotes] = useState('');
  const [workModels, setWorkModels] = useState<WorkModelDef[]>([]);

  // Live "after" preview for the Edit Entry modal: the total the save will
  // persist (preserved earlier segments + the edited shift), computed with the
  // SAME buildConsistentClosePatch('append') logic the save uses. On load with
  // no edits this equals the "before" total (getEntryTotals) — previously the
  // preview collapsed the multi-shift day to one shift and showed a bogus drop.
  const editAfterHours = useMemo(() => {
    if (!originalEditingEntry || !editingEntry?.clockInManual || !editingEntry?.clockOutManual) {
      return null;
    }
    // clockOutSystem omitted: the total is derived from the manual HH:MM span,
    // so the preview is a pure function of the form values (no Date.now()).
    const patch = buildConsistentClosePatch({
      clockIn: editingEntry.clockInManual,
      clockOut: editingEntry.clockOutManual,
      skipLunch: !!editingEntry.skipLunch,
      lunchOut: editingEntry.skipLunch ? undefined : (editingEntry.lunchOutManual || undefined),
      lunchIn: editingEntry.skipLunch ? undefined : (editingEntry.lunchInManual || undefined),
      existingSegments: getPreservedSegmentsForEdit(originalEditingEntry),
      mode: 'append',
    });
    return patch.totalWorkMinutes / 60;
  }, [originalEditingEntry, editingEntry]);

  // Req 4: display a time boundary in the selected admin view zone. Uses the
  // absolute epoch system timestamp when present (converts to employee-local
  // or PT), else the stored manual string as-is (legacy rows).
  const fmtTz = (epochMs: number | undefined, manualFallback: string | undefined, empTz?: string): string => {
    const shown = displayTimeForView(epochMs, manualFallback, timeViewMode, empTz);
    return shown || '--';
  };
  const tzForUser = (userId?: string): string | undefined =>
    allUsers.find((u) => u.uid === userId)?.timezone;

  useEffect(() => {
    listWorkModels().then(setWorkModels).catch(e => console.error('Failed to load work models', e));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability
    loadEntries();
  }, []);

  const loadEntries = async () => {
    setLoading(true);
    try {
      const data = await dbService.getAllTimeEntries();
      setEntries(data);
    } catch {
      toast.error('Failed to load entries');
    } finally {
      setLoading(false);
    }
  };

  // Derived during render (no filter effect/state) so React never sees a
  // synchronous setState inside an effect (react-hooks/set-state-in-effect).
  const filteredEntries = useMemo(() => {
    let filtered = filterByExclusionCutoff(entries, exclusionCutoff, e => e.date);

    // Attribute pre-fix cross-midnight split segments to their own local
    // dates (23:32→00:28 → 07/29 23:32→23:59 + 07/30 00:00→00:28) so the Team
    // tab lists and filters each day-portion under the correct date.
    // Recompute day-level flags per part (calculateFlags uses totalHours +
    // lunch) so a doc-level flag isn't duplicated across both halves.
    filtered = explodeDocsBySegmentLocalDate(filtered).map((e) => ({
      ...e,
      flags: dbService.calculateFlags(e),
    }));

    const matchesUser = buildUserIdMatcher(selectedUserId, allUsers);
    filtered = filtered.filter(e => matchesUser(e.userId));

    if (startDate) {
      filtered = filtered.filter(e => e.date >= startDate);
    }

    if (endDate) {
      filtered = filtered.filter(e => e.date <= endDate);
    }

    if (status === 'complete') {
      filtered = filtered.filter(e => e.complete);
    } else if (status === 'incomplete') {
      filtered = filtered.filter(e => !e.complete);
    } else if (status === 'flagged') {
      filtered = filtered.filter(e => e.flags && e.flags.length > 0);
    }

    // Re-sort newest-first after the cross-midnight explosion. The explosion
    // returns a split doc's parts in ASCENDING localDate order (Day 1 then
    // Day 2), which left the earlier date above the later date (07/29 above
    // 07/30). Matching HistoryView / shiftRows, sort by date descending so the
    // later day-portion (and any same-date real docs) land above the earlier.
    filtered.sort((a, b) => b.date.localeCompare(a.date));

    return filtered;
  }, [entries, selectedUserId, startDate, endDate, status, allUsers, exclusionCutoff]);

  const setQuickDate = (preset: string) => {
    // Bug fix: previously used `today.getDay()` and `setDate()` in local TZ.
    // UTC-anchored so the week boundary is stable regardless of runtime TZ.
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const [ty, tm, td] = todayStr.split('-').map(Number);
    const todayUtc = new Date(Date.UTC(ty, tm - 1, td));
    const day = todayUtc.getUTCDay();

    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    switch (preset) {
      case 'today':
        setStartDate(todayStr);
        setEndDate(todayStr);
        break;
      case 'yesterday': {
        const y = new Date(todayUtc);
        y.setUTCDate(y.getUTCDate() - 1);
        const yStr = fmt(y);
        setStartDate(yStr);
        setEndDate(yStr);
        break;
      }
      case 'this_week': {
        const weekStart = new Date(todayUtc);
        weekStart.setUTCDate(weekStart.getUTCDate() - day);
        setStartDate(fmt(weekStart));
        setEndDate(todayStr);
        break;
      }
      case 'last_week': {
        const lastWeekEnd = new Date(todayUtc);
        lastWeekEnd.setUTCDate(lastWeekEnd.getUTCDate() - day - 1);
        const lastWeekStart = new Date(lastWeekEnd);
        lastWeekStart.setUTCDate(lastWeekEnd.getUTCDate() - 6);
        setStartDate(fmt(lastWeekStart));
        setEndDate(fmt(lastWeekEnd));
        break;
      }
      case 'this_month': {
        const monthStart = new Date(Date.UTC(ty, tm - 1, 1));
        setStartDate(fmt(monthStart));
        setEndDate(todayStr);
        break;
      }
    }
  };

  const exportCSV = () => {
    const headers = ['Employee', 'Date', 'Clock In', 'Clock Out', 'Total Hours', 'Status', 'Flags'];
    const rows = filteredEntries.map(entry => {
      const employee = allUsers.find(u => u.uid === entry.userId);
      return [
        employee?.name || 'Unknown',
        entry.date,
        entry.clockInManual || '',
        entry.clockOutManual || '',
        entry.totalHours?.toFixed(2) || '',
        entry.complete ? 'Complete' : 'Incomplete',
        entry.flags?.join('; ') || '',
      ];
    });

    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `time-entries-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    toast.success('CSV exported');
  };

  const printReport = () => {
    window.print();
    toast.success('Opening print dialog');
  };

  const getUserName = (userId: string) => {
    const user = allUsers.find(u => u.uid === userId);
    return user?.name || 'Unknown';
  };

  const viewDetails = (entry: TimeEntry) => {
    setSelectedEntry(entry);
    setDetailsOpen(true);
  };

  // Exploded synthetic day-portions (from the cross-midnight localDate
  // explosion) must be edited/voided via their SOURCE doc — the persisted
  // cross-midnight record — not the synthetic `${sourceId}@${date}` display id
  // (which does not exist in Firestore and whose partial segments[] would
  // corrupt the doc if written back with the 'replace' close-patch).
  //
  // Resolve to the full source entry: first from the loaded `entries` (fast
  // path), then — if absent (filtered out / not yet loaded) — fetched directly
  // from Firestore by its sourceId. If the source genuinely doesn't exist,
  // THROW so the caller aborts with a clear error instead of silently writing
  // to a nonexistent synthetic id (which would fail or, with legacy ids,
  // corrupt an unrelated doc).
  const resolveSourceEntry = async (entry: TimeEntry): Promise<TimeEntry> => {
    if (!entry.synthetic || !entry.sourceId) return entry;
    const found = entries.find((e) => e.id === entry.sourceId);
    if (found) return found;
    const fetched = await dbService.getTimeEntryById(entry.sourceId);
    if (!fetched) {
      throw new Error('The source time entry for this shift could not be found. It may have been removed.');
    }
    return fetched;
  };

  const handleEditClick = async (entry: TimeEntry) => {
    try {
      const source = await resolveSourceEntry(entry);
      setEditingEntry({ ...source });
      setOriginalEditingEntry(source);
      setAdminNotes(source.adminNotes || '');
      setEditEntryOpen(true);
    } catch (e: unknown) {
      toast.error((e as Error).message || 'Cannot edit this entry');
    }
  };

  const handleSaveEdit = async () => {
    if (!editingEntry || !originalEditingEntry || !adminNotes.trim()) {
      toast.error('Admin notes are required');
      return;
    }

    try {
      if (!editingEntry.clockInManual || !editingEntry.clockOutManual) {
        toast.error('Clock In and Clock Out are required');
        return;
      }

      const entryToValidate: Partial<TimeEntry> = {
        clockInManual: editingEntry.clockInManual,
        clockOutManual: editingEntry.clockOutManual,
        lunchOutManual: editingEntry.skipLunch ? '' : (editingEntry.lunchOutManual || ''),
        lunchInManual: editingEntry.skipLunch ? '' : (editingEntry.lunchInManual || ''),
      };

      const errors = validateTimeEntry(entryToValidate);
      if (errors.length > 0) {
        toast.error(errors[0]);
        return;
      }

      const now = Timestamp.now();
      const lunchMinutes = calculateLunchMinutes(
        editingEntry.skipLunch ? '' : (editingEntry.lunchOutManual || ''),
        editingEntry.skipLunch ? '' : (editingEntry.lunchInManual || '')
      );
      // S7: derive totalWorkMinutes + a synchronized segments[] from the same
      // canonical closeActiveSegment math (S6 cross-midnight wrap + lunch
      // deduction) so root fields, segments[last], and totalWorkMinutes can
      // never diverge. 'append' mode PRESERVES the day's earlier split-shift
      // segments and replaces only the targeted (current/last) shift in-place —
      // the old 'replace' mode collapsed the whole multi-shift day into one
      // shift, destroying the other segments' minutes (data loss) and making
      // the modal preview "before" (full day) diverge from "after" (collapsed).
      const preservedSegs = getPreservedSegmentsForEdit(originalEditingEntry);
      const closePatch = buildConsistentClosePatch({
        clockIn: editingEntry.clockInManual,
        clockOut: editingEntry.clockOutManual,
        skipLunch: !!editingEntry.skipLunch,
        lunchOut: editingEntry.skipLunch ? undefined : (editingEntry.lunchOutManual || undefined),
        lunchIn: editingEntry.skipLunch ? undefined : (editingEntry.lunchInManual || undefined),
        clockOutSystem: now.toMillis(),
        existingSegments: preservedSegs,
        mode: 'append',
      });
      const totalWorkMinutes = closePatch.totalWorkMinutes;
      const editedUser = allUsers.find(u => u.uid === originalEditingEntry.userId);
      const editedTz = editedUser?.timezone;
      // Recompute the corrected shift's *System epochs from the edited manual
      // times (the SSOT for instants). buildConsistentClosePatch stamps
      // clockOutSystem with "now" — the moment of the edit — which made Payroll
      // rows / Team view show the editing time as the clock-out. Recompute all
      // four boundaries from the manual strings + entry date + employee tz.
      const sysSeg = editedTz
        ? recomputeSegmentSystemTimestamps(closePatch.closedSegment, originalEditingEntry.date, editedTz)
        : closePatch.closedSegment;
      const segments = closePatch.segments.map((s) =>
        (s.id === closePatch.closedSegment.id ? stripUndefined(sysSeg) : s),
      );
      // Top-level *System fields (millis + Firestore Timestamp) so Team view /
      // mapEntry (which read the top-level *SystemTime) show the edited
      // instants instead of "now".
      const systemPatch = editedTz
        ? stripUndefined({
            clockInSystem: sysSeg.clockInSystem,
            clockOutSystem: sysSeg.clockOutSystem,
            lunchOutSystem: editingEntry.skipLunch ? undefined : sysSeg.lunchOutSystem,
            lunchInSystem: editingEntry.skipLunch ? undefined : sysSeg.lunchInSystem,
            clockInSystemTime: sysSeg.clockInSystem != null ? Timestamp.fromMillis(sysSeg.clockInSystem) : undefined,
            clockOutSystemTime: sysSeg.clockOutSystem != null ? Timestamp.fromMillis(sysSeg.clockOutSystem) : undefined,
            lunchOutSystemTime: editingEntry.skipLunch || sysSeg.lunchOutSystem == null ? undefined : Timestamp.fromMillis(sysSeg.lunchOutSystem),
            lunchInSystemTime: editingEntry.skipLunch || sysSeg.lunchInSystem == null ? undefined : Timestamp.fromMillis(sysSeg.lunchInSystem),
          })
        : {};
      const editedWorkModel = editedUser?.workModelId ? workModels.find(m => m.id === editedUser.workModelId) ?? null : null;
      const ot = calculateDailyOvertimeBreakdown(totalWorkMinutes, editedWorkModel, editedUser?.workModelOverride ?? null);
      // originalEditingEntry is definitely defined here so we can guarantee we have a date
      const workWeekStartDate = getWorkWeekStartDate(originalEditingEntry.date, DEFAULT_WORKWEEK_START_DAY);

      // === IMMUTABLE AUDIT TRAIL (Phase 1 requirement) ===
      const beforeSnapshot = JSON.parse(JSON.stringify(originalEditingEntry));
      const afterSnapshot = {
        ...originalEditingEntry,
        clockInManual: editingEntry.clockInManual,
        lunchOutManual: editingEntry.skipLunch ? '' : (editingEntry.lunchOutManual || ''),
        lunchInManual: editingEntry.skipLunch ? '' : (editingEntry.lunchInManual || ''),
        clockOutManual: editingEntry.clockOutManual,
        lunchSkipped: !!editingEntry.skipLunch,
        lunchMinutes,
        totalWorkMinutes,
        segments,
        regularMinutes: ot.regularMinutes,
        otMinutes: ot.otMinutes,
        doubleTimeMinutes: ot.doubleTimeMinutes,
        workWeekStartDate,
        dayComplete: true,
        currentStep: 'complete',
        correctedAt: now.toMillis(),
        correctedBy: user.uid,
        correctionNotes: adminNotes.trim(),
      };

      // Write audit log FIRST. Manager-initiated correction; reason optional
      // (policy change 2026-08). Pass actorRole explicitly so the audit row
      // reflects the actual actor (the service defaults to 'admin').
      await auditLogService.logTimeCorrection({
        actorUid: user.uid,
        actorName: user.name || user.email,
        actorRole: 'manager',
        targetId: originalEditingEntry.id,
        before: beforeSnapshot,
        after: afterSnapshot,
        reason: adminNotes.trim(),
      });

      // Only after durable audit row exists do we mutate the time record.
      // When the edited shift has no lunch, explicitly NULL the top-level lunch
      // *System fields — a prior segment's lunch epoch would otherwise linger
      // (the Audit Viewer showed it as an out-of-order submission stamped
      // before this shift's clock-in).
      const shiftHasLunch =
        !editingEntry.skipLunch && !!editingEntry.lunchOutManual && !!editingEntry.lunchInManual;
      await updateDoc(doc(db, 'timeEntries', originalEditingEntry.id), {
        clockInManual: editingEntry.clockInManual,
        lunchOutManual: editingEntry.skipLunch ? '' : (editingEntry.lunchOutManual || ''),
        lunchInManual: editingEntry.skipLunch ? '' : (editingEntry.lunchInManual || ''),
        clockOutManual: editingEntry.clockOutManual,
        lunchSkipped: !!editingEntry.skipLunch,
        lunchMinutes,
        totalWorkMinutes,
        segments,
        ...systemPatch,
        ...(shiftHasLunch
          ? {}
          : { lunchOutSystem: null, lunchInSystem: null, lunchOutSystemTime: null, lunchInSystemTime: null }),
        regularMinutes: ot.regularMinutes,
        otMinutes: ot.otMinutes,
        doubleTimeMinutes: ot.doubleTimeMinutes,
        workWeekStartDate,
        dayComplete: true,
        currentStep: 'complete',
        correctedAt: now,
        correctedBy: user.uid,
        correctionNotes: adminNotes.trim(),
        updatedAt: now,
        updatedBy: user.uid,
      });

      toast.success('Entry updated successfully');
      setEditEntryOpen(false);
      loadEntries();
    } catch {
      toast.error('Failed to update entry');
    }
  };

  const handleVoidEntry = async (entry: TimeEntry) => {
    const reason = window.prompt('Reason for voiding this entry (required):');
    if (!reason || !reason.trim()) {
      toast.error('Reason is required to void an entry');
      return;
    }
    try {
      // Void the persisted source doc (a synthetic day-portion can't be voided
      // on its own — its synthetic id doesn't exist in Firestore). Resolved
      // (fetched on demand if absent from the loaded list); throws if the
      // source genuinely doesn't exist.
      const source = await resolveSourceEntry(entry);
      const before = { ...source };
      await auditLogService.logVoidEntry({
        actorUid: user.uid,
        actorName: user.name || user.email,
        actorRole: 'admin',
        targetId: source.id,
        before,
        reason: reason.trim(),
      });
      await updateDoc(doc(db, 'timeEntries', source.id), {
        status: 'voided',
        voidedAt: Timestamp.now(),
        voidedBy: user.uid,
        voidReason: reason.trim(),
        updatedAt: Timestamp.now(),
        updatedBy: user.uid,
      });
      toast.success('Entry voided');
      loadEntries();
    } catch (e: unknown) {
      toast.error((e as Error).message || 'Failed to void entry');
    }
  };

  const totalFlags = filteredEntries.reduce((acc, e) => acc + (e.flags?.length || 0), 0);
  const totalHours = filteredEntries.reduce((acc, e) => acc + (e.totalHours || 0), 0);
  const totalEntries = filteredEntries.length;
  const activeEmployees = new Set(filteredEntries.map(e => e.userId)).size;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm mb-4">
        <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          Team Dashboard
        </h2>
        <SectionHelp 
          title="Team Dashboard"
          description="Track active sessions and live time punches for your workforce today."
          sections={[
            { title: "Status Tracking", content: "View who is clocked in, on lunch, or checked out currently." },
            { title: "Employee Filter", content: "Drill down into a single user's daily record set across the period." },
            { title: "Session Edits", content: "Correct entry fields or clear flawed shift starts to fix block status." }
          ]}
        />
      </div>
      {/* Stats - Compact */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <Card className="border-none shadow-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white rounded-2xl overflow-hidden hover:scale-[1.02] transition-transform">
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <div className="bg-white/20 p-3 rounded-xl backdrop-blur-sm">
                <Calendar className="size-6 text-white" />
              </div>
              <div>
                <p className="text-xs text-indigo-100 uppercase tracking-wider font-semibold">Total Time Records</p>
                <p className="text-3xl font-black drop-shadow-md">{totalEntries}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white rounded-2xl overflow-hidden hover:scale-[1.02] transition-transform">
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <div className="bg-white/20 p-3 rounded-xl backdrop-blur-sm">
                <Clock className="size-6 text-white" />
              </div>
              <div>
                <p className="text-xs text-emerald-100 uppercase tracking-wider font-semibold">Total Hours</p>
                <p className="text-3xl font-black drop-shadow-md">{totalHours.toFixed(1)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-xl bg-gradient-to-br from-blue-400 to-cyan-500 text-white rounded-2xl overflow-hidden hover:scale-[1.02] transition-transform">
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <div className="bg-white/20 p-3 rounded-xl backdrop-blur-sm">
                <Users className="size-6 text-white" />
              </div>
              <div>
                <p className="text-xs text-blue-100 uppercase tracking-wider font-semibold">Active Employees</p>
                <p className="text-3xl font-black drop-shadow-md">{activeEmployees}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer border-none shadow-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white rounded-2xl overflow-hidden hover:scale-[1.02] transition-transform"
          onClick={() => setStatus('flagged')}
        >
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <div className="bg-white/20 p-3 rounded-xl backdrop-blur-sm">
                <AlertTriangle className="size-6 text-white" />
              </div>
              <div>
                <p className="text-xs text-amber-100 uppercase tracking-wider font-semibold">Flags</p>
                <p className="text-3xl font-black drop-shadow-md">{totalFlags}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters - Compact */}
      <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl">
        <CardHeader className="pb-3 border-b border-indigo-50 bg-white/40">
          <CardTitle className="text-base flex items-center gap-2 text-slate-800 font-bold">
            <div className="bg-indigo-100/80 p-1.5 rounded-md">
              <Filter className="size-4 text-indigo-600" />
            </div>
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Employee</Label>
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger className="h-9">
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
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">End Date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                  <SelectItem value="incomplete">Incomplete</SelectItem>
                  <SelectItem value="flagged">Flagged</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setQuickDate('today')} className="h-8 text-xs">
              Today
            </Button>
            <Button variant="outline" size="sm" onClick={() => setQuickDate('yesterday')} className="h-8 text-xs">
              Yesterday
            </Button>
            <Button variant="outline" size="sm" onClick={() => setQuickDate('this_week')} className="h-8 text-xs">
              This Week
            </Button>
            <Button variant="outline" size="sm" onClick={() => setQuickDate('this_month')} className="h-8 text-xs">
              This Month
            </Button>
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <Download className="size-3 mr-1" />
              Export
            </Button>
            <Button variant="outline" size="sm" onClick={printReport}>
              <Printer className="size-3 mr-1" />
              Print
            </Button>
            <Button variant="outline" size="sm" onClick={loadEntries}>
              <RefreshCw className="size-3 mr-1" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Entries Grid/List */}
      <div className="space-y-3">
        {filteredEntries.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No entries found"
            description="No time entries match your current filters. Try adjusting the date range or filters."
          />
        ) : (
          filteredEntries.map(entry => {
            const employee = allUsers.find(u => u.uid === entry.userId);
            return (
              <Card key={entry.id} className="border border-white/80 shadow-md bg-white/60 backdrop-blur-md rounded-2xl hover:shadow-xl hover:-translate-y-1 transition-all duration-300">
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <UserAvatar name={employee?.name || 'Unknown'} size="md" />
                      <div>
                        <p className="font-semibold text-sm text-foreground">{employee?.name}</p>
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-muted-foreground">{entry.date}</p>
                          {entry.complete ? (
                            <StatusDot status="complete" />
                          ) : (
                            <StatusDot status="incomplete" />
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {entry.totalHours ? (
                        <div className="text-right">
                          <p className="text-xl font-bold text-primary">{entry.totalHours.toFixed(1)}</p>
                          <p className="text-xs text-muted-foreground">hours</p>
                        </div>
                      ) : (
                        <Badge variant="secondary" className="text-xs">Incomplete</Badge>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <MoreVertical className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => viewDetails(entry)}>
                            <Eye className="size-4 mr-2" />
                            View Details
                          </DropdownMenuItem>
                          {user.role === 'admin' && (
                            <>
                              <DropdownMenuItem onClick={() => handleEditClick(entry)}>
                                <Edit className="size-4 mr-2" />
                                Edit Entry
                              </DropdownMenuItem>
                              <DropdownMenuItem className="text-red-600" onClick={() => handleVoidEntry(entry)}>
                                <Trash2 className="size-4 mr-2" />
                                Void Entry
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {(() => {
                    const segs = (entry.segments || []).filter((s) => s.clockInManual || s.clockInSystem);
                    // Multi-shift (split-shift) day: the top-level In/Out mirror
                    // only the LAST shift, which made the row total (the sum of
                    // ALL shifts) look inconsistent with the single displayed
                    // span. Render each shift's In/Out + minutes so the displayed
                    // timestamps sum mathematically to the card total.
                    if (segs.length > 1) {
                      return (
                        <div className="mb-2 rounded-lg border border-border divide-y divide-border overflow-hidden">
                          {segs.map((seg, i) => (
                            <div key={seg.id || i} className="flex items-center justify-between px-2 py-1.5 text-xs bg-muted/40">
                              <span className="text-muted-foreground font-medium">Shift {i + 1}</span>
                              <span className="tabular-nums font-semibold">
                                {fmtTz(seg.clockInSystem, seg.clockInManual, tzForUser(entry.userId))}
                                {' – '}
                                {fmtTz(seg.clockOutSystem, seg.clockOutManual, tzForUser(entry.userId))}
                              </span>
                              <span className="tabular-nums text-muted-foreground">
                                {(computeSegmentWorkMinutes(seg) / 60).toFixed(2)}h
                              </span>
                            </div>
                          ))}
                        </div>
                      );
                    }
                    // Single shift: the original In/Out grid (top-level fields).
                    return (
                      <div className="grid grid-cols-2 gap-2 mb-2">
                        <div className="bg-muted/50 p-2 rounded text-center border border-border">
                          <p className="text-xs text-muted-foreground mb-0.5">In</p>
                          <p className="text-sm font-bold">{fmtTz(entry.clockInSystem, entry.clockInManual, tzForUser(entry.userId))}</p>
                        </div>
                        <div className="bg-muted/50 p-2 rounded text-center border border-border">
                          <p className="text-xs text-muted-foreground mb-0.5">Out</p>
                          <p className="text-sm font-bold">{fmtTz(entry.clockOutSystem, entry.clockOutManual, tzForUser(entry.userId))}</p>
                        </div>
                      </div>
                    );
                  })()}

                  {entry.flags && entry.flags.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded p-2 flex items-center gap-2">
                      <AlertTriangle className="size-3 text-amber-600" />
                      <span className="text-xs text-amber-800">{entry.flags.length} flag(s)</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Details Dialog */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Entry Details</DialogTitle>
          </DialogHeader>
          {selectedEntry && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-slate-50 p-2 rounded">
                  <p className="text-xs text-slate-600">Employee</p>
                  <p className="font-semibold text-sm">{getUserName(selectedEntry.userId)}</p>
                </div>
                <div className="bg-slate-50 p-2 rounded">
                  <p className="text-xs text-slate-600">Date</p>
                  <p className="font-semibold text-sm">{selectedEntry.date}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="bg-slate-50 p-2 rounded border border-slate-200">
                  <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                    <LogIn className="size-3" /> Clock In
                  </p>
                  <p className="font-bold">{fmtTz(selectedEntry.clockInSystem, selectedEntry.clockInManual, tzForUser(selectedEntry.userId))}</p>
                </div>
                <div className="bg-slate-50 p-2 rounded border border-slate-200">
                  <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                    <LogOut className="size-3" /> Clock Out
                  </p>
                  <p className="font-bold">{fmtTz(selectedEntry.clockOutSystem, selectedEntry.clockOutManual, tzForUser(selectedEntry.userId))}</p>
                </div>
                {!selectedEntry.skipLunch && (
                  <>
                    <div className="bg-slate-50 p-2 rounded border border-slate-200">
                      <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                        <Coffee className="size-3" /> Lunch Start
                      </p>
                      <p className="font-bold text-sm">{fmtTz(selectedEntry.lunchOutSystem, selectedEntry.lunchOutManual, tzForUser(selectedEntry.userId))}</p>
                    </div>
                    <div className="bg-slate-50 p-2 rounded border border-slate-200">
                      <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                        <Coffee className="size-3" /> Lunch End
                      </p>
                      <p className="font-bold text-sm">{fmtTz(selectedEntry.lunchInSystem, selectedEntry.lunchInManual, tzForUser(selectedEntry.userId))}</p>
                    </div>
                  </>
                )}
              </div>

              {/* Multi-shift (split-shift) breakdown: the top-level In/Out above
                  mirror only the LAST shift. List every shift's In/Out + minutes
                  so the displayed timestamps sum mathematically to the total. */}
              {(() => {
                const segs = (selectedEntry.segments || []).filter((s) => s.clockInManual || s.clockInSystem);
                if (segs.length <= 1) return null;
                return (
                  <div className="rounded-lg border border-slate-200 divide-y divide-slate-200 overflow-hidden">
                    <p className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 bg-slate-50">
                      {segs.length} shifts this day
                    </p>
                    {segs.map((seg, i) => (
                      <div key={seg.id || i} className="flex items-center justify-between px-2 py-1.5 text-xs">
                        <span className="text-slate-500 font-medium">Shift {i + 1}</span>
                        <span className="tabular-nums font-semibold">
                          {fmtTz(seg.clockInSystem, seg.clockInManual, tzForUser(selectedEntry.userId))}
                          {' – '}
                          {fmtTz(seg.clockOutSystem, seg.clockOutManual, tzForUser(selectedEntry.userId))}
                        </span>
                        <span className="tabular-nums text-slate-500">
                          {(computeSegmentWorkMinutes(seg) / 60).toFixed(2)}h
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {selectedEntry.complete && (
                <div className="bg-blue-50 p-3 rounded border border-blue-200">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-slate-700">Total Hours</span>
                    <span className="text-2xl font-bold text-blue-600">{selectedEntry.totalHours?.toFixed(2)}</span>
                  </div>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Regular</span>
                      <span className="font-semibold">{selectedEntry.regularHours?.toFixed(2)}</span>
                    </div>
                    {selectedEntry.overtimeHours! > 0 && (
                      <div className="flex justify-between text-orange-700">
                        <span>OT (1.5x)</span>
                        <span className="font-semibold">{selectedEntry.overtimeHours!.toFixed(2)}</span>
                      </div>
                    )}
                    {selectedEntry.doubleTimeHours! > 0 && (
                      <div className="flex justify-between text-red-700">
                        <span>DT (2x)</span>
                        <span className="font-semibold">{selectedEntry.doubleTimeHours!.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedEntry.flags && selectedEntry.flags.length > 0 && (
                <div className="bg-amber-50 border border-amber-300 rounded p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="size-4 text-amber-600" />
                    <p className="text-sm font-semibold text-amber-900">Flags</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {selectedEntry.flags.map((flag, i) => (
                      <Badge key={i} variant="outline" className="text-xs bg-white border-amber-400 text-amber-800">{flag}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Entry Dialog */}
      <Dialog open={editEntryOpen} onOpenChange={setEditEntryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Time Entry</DialogTitle>
          </DialogHeader>
          {editingEntry && originalEditingEntry && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Employee</Label>
                  <Input value={getUserName(originalEditingEntry.userId)} disabled />
                </div>
                <div>
                  <Label>Date</Label>
                  <Input value={originalEditingEntry.date} disabled />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 p-4 border rounded-lg">
                <div>
                  <Label>Clock In</Label>
                  <Input
                    type="time"
                    value={editingEntry.clockInManual || ''}
                    onChange={(e) => setEditingEntry({ ...editingEntry, clockInManual: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Clock Out</Label>
                  <Input
                    type="time"
                    value={editingEntry.clockOutManual || ''}
                    onChange={(e) => setEditingEntry({ ...editingEntry, clockOutManual: e.target.value })}
                  />
                </div>
                {!editingEntry.skipLunch && (
                  <>
                    <div>
                      <Label>Lunch Out</Label>
                      <Input
                        type="time"
                        value={editingEntry.lunchOutManual || ''}
                        onChange={(e) => setEditingEntry({ ...editingEntry, lunchOutManual: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Lunch In</Label>
                      <Input
                        type="time"
                        value={editingEntry.lunchInManual || ''}
                        onChange={(e) => setEditingEntry({ ...editingEntry, lunchInManual: e.target.value })}
                      />
                    </div>
                  </>
                )}
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="skipLunch"
                  checked={!!editingEntry.skipLunch}
                  onCheckedChange={(checked) => setEditingEntry({ ...editingEntry, skipLunch: !!checked })}
                />
                <Label htmlFor="skipLunch">Skip Lunch / Paid Lunch</Label>
              </div>

              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 mt-4 space-y-1">
                <p className="text-sm font-semibold text-slate-700 mb-2">Preview Changes</p>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500">Total hours before:</span>
                  <span className="font-medium">{getEntryTotals(originalEditingEntry).totalHours.toFixed(2)} hrs</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500">Total hours after:</span>
                  <span className="font-bold text-indigo-700">{(editAfterHours ?? getEntryTotals(editingEntry as TimeEntry).totalHours).toFixed(2)} hrs</span>
                </div>
              </div>

              <div>
                <Label>Admin Notes / Reason for Correction (Required)</Label>
                <Textarea
                  placeholder="Explain why this entry was corrected..."
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  className="mt-1"
                />
              </div>

              <div className="flex justify-end gap-2 pt-4">
                <Button variant="outline" onClick={() => setEditEntryOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSaveEdit}>
                  Save Changes
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}