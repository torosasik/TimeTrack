import { useState, useEffect } from 'react';
import { User } from '../../lib/auth';
import { SectionHelp } from '../ui/section-help';
import { TimeEntry, dbService } from '../../lib/database';
import { doc, updateDoc, deleteDoc, Timestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Badge } from '../ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { UserAvatar } from '../ui/user-avatar';
import { StatusDot } from '../ui/status-dot';
import { EmptyState } from '../ui/empty-state';
import { Textarea } from '../ui/textarea';
import { Checkbox } from '../ui/checkbox';
import { calculateLunchMinutes, calculateTotalWorkMinutes, validateTimeEntry } from '../../../utils/timeCalculations';
import { calculateDailyOvertimeBreakdown, getWorkWeekStartDate, DEFAULT_WORKWEEK_START_DAY } from '../../../utils/overtimeCalculations';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { toast } from 'sonner';
import { Download, Printer, RefreshCw, Eye, Users, AlertTriangle, Calendar, Clock, Filter, LogIn, LogOut, Coffee, CheckCircle2, XCircle, MoreVertical, Edit, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

interface TeamDashboardProps {
  user: User;
  allUsers: User[];
}

export function TeamDashboard({ user, allUsers }: TeamDashboardProps) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [filteredEntries, setFilteredEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState<string>('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [selectedEntry, setSelectedEntry] = useState<TimeEntry | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  // Edit Entry State
  const [editEntryOpen, setEditEntryOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<Partial<TimeEntry> | null>(null);
  const [originalEditingEntry, setOriginalEditingEntry] = useState<TimeEntry | null>(null);
  const [adminNotes, setAdminNotes] = useState('');

  useEffect(() => {
    loadEntries();
  }, []);

  useEffect(() => {
    applyFilters();
  }, [entries, selectedUserId, startDate, endDate, status]);

  const loadEntries = async () => {
    setLoading(true);
    try {
      const data = await dbService.getAllTimeEntries();
      setEntries(data);
    } catch (error) {
      toast.error('Failed to load entries');
    } finally {
      setLoading(false);
    }
  };

  const applyFilters = () => {
    let filtered = [...entries];

    if (selectedUserId !== 'all') {
      filtered = filtered.filter(e => e.userId === selectedUserId);
    }

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

    setFilteredEntries(filtered);
  };

  const setQuickDate = (preset: string) => {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    switch (preset) {
      case 'today':
        setStartDate(todayStr);
        setEndDate(todayStr);
        break;
      case 'yesterday':
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        setStartDate(yesterdayStr);
        setEndDate(yesterdayStr);
        break;
      case 'this_week':
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay());
        setStartDate(weekStart.toISOString().split('T')[0]);
        setEndDate(todayStr);
        break;
      case 'last_week':
        const lastWeekEnd = new Date(today);
        lastWeekEnd.setDate(today.getDate() - today.getDay() - 1);
        const lastWeekStart = new Date(lastWeekEnd);
        lastWeekStart.setDate(lastWeekEnd.getDate() - 6);
        setStartDate(lastWeekStart.toISOString().split('T')[0]);
        setEndDate(lastWeekEnd.toISOString().split('T')[0]);
        break;
      case 'this_month':
        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
        setStartDate(monthStart.toISOString().split('T')[0]);
        setEndDate(todayStr);
        break;
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

  const handleEditClick = (entry: TimeEntry) => {
    setEditingEntry({ ...entry });
    setOriginalEditingEntry(entry);
    setAdminNotes(entry.adminNotes || '');
    setEditEntryOpen(true);
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
      const totalWorkMinutes = calculateTotalWorkMinutes(
        editingEntry.clockInManual,
        editingEntry.clockOutManual,
        lunchMinutes
      );
      const ot = calculateDailyOvertimeBreakdown(totalWorkMinutes);
      // originalEditingEntry is definitely defined here so we can guarantee we have a date
      const workWeekStartDate = getWorkWeekStartDate(originalEditingEntry.date, DEFAULT_WORKWEEK_START_DAY);

      await updateDoc(doc(db, 'timeEntries', originalEditingEntry.id), {
        clockInManual: editingEntry.clockInManual,
        lunchOutManual: editingEntry.skipLunch ? '' : (editingEntry.lunchOutManual || ''),
        lunchInManual: editingEntry.skipLunch ? '' : (editingEntry.lunchInManual || ''),
        clockOutManual: editingEntry.clockOutManual,
        lunchSkipped: !!editingEntry.skipLunch,
        lunchMinutes,
        totalWorkMinutes,
        regularMinutes: ot.regularMinutes,
        otMinutes: ot.otMinutes,
        doubleTimeMinutes: ot.doubleTimeMinutes,
        workWeekStartDate,
        dayComplete: true,
        currentStep: 'complete',
        correctedAt: now,
        correctedBy: user.uid,
        correctionNotes: adminNotes,
        updatedAt: now,
        updatedBy: user.uid,
      } as any);

      toast.success('Entry updated successfully');
      setEditEntryOpen(false);
      loadEntries();
    } catch (error) {
      toast.error('Failed to update entry');
    }
  };

  const handleDeleteEntry = async (entry: TimeEntry) => {
    if (window.confirm('Are you sure you want to delete this entry? This cannot be undone.')) {
      try {
        await deleteDoc(doc(db, 'timeEntries', entry.id));
        toast.success('Entry deleted');
        loadEntries();
      } catch (error) {
        toast.error('Failed to delete entry');
      }
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
                  <SelectItem value="all">All Employees</SelectItem>
                  {allUsers.filter(u => u.role === 'employee').map(u => (
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
                              <DropdownMenuItem className="text-red-600" onClick={() => handleDeleteEntry(entry)}>
                                <Trash2 className="size-4 mr-2" />
                                Delete Entry
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div className="bg-muted/50 p-2 rounded text-center border border-border">
                      <p className="text-xs text-muted-foreground mb-0.5">In</p>
                      <p className="text-sm font-bold">{entry.clockInManual || '--'}</p>
                    </div>
                    <div className="bg-muted/50 p-2 rounded text-center border border-border">
                      <p className="text-xs text-muted-foreground mb-0.5">Out</p>
                      <p className="text-sm font-bold">{entry.clockOutManual || '--'}</p>
                    </div>
                  </div>

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
                  <p className="font-bold">{selectedEntry.clockInManual || '--'}</p>
                </div>
                <div className="bg-slate-50 p-2 rounded border border-slate-200">
                  <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                    <LogOut className="size-3" /> Clock Out
                  </p>
                  <p className="font-bold">{selectedEntry.clockOutManual || '--'}</p>
                </div>
                {!selectedEntry.skipLunch && (
                  <>
                    <div className="bg-slate-50 p-2 rounded border border-slate-200">
                      <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                        <Coffee className="size-3" /> Lunch Start
                      </p>
                      <p className="font-bold text-sm">{selectedEntry.lunchOutManual || '--'}</p>
                    </div>
                    <div className="bg-slate-50 p-2 rounded border border-slate-200">
                      <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                        <Coffee className="size-3" /> Lunch End
                      </p>
                      <p className="font-bold text-sm">{selectedEntry.lunchInManual || '--'}</p>
                    </div>
                  </>
                )}
              </div>

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
                  <span className="font-medium">{dbService.calculateTotalHours(originalEditingEntry).toFixed(2)} hrs</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500">Total hours after:</span>
                  <span className="font-bold text-indigo-700">{dbService.calculateTotalHours(editingEntry as TimeEntry).toFixed(2)} hrs</span>
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