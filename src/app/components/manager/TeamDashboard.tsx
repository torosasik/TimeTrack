import { useState, useEffect } from 'react';
import { User } from '../../lib/auth';
import { TimeEntry, dbService } from '../../lib/database';
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

  const totalFlags = filteredEntries.reduce((acc, e) => acc + (e.flags?.length || 0), 0);
  const totalHours = filteredEntries.reduce((acc, e) => acc + (e.totalHours || 0), 0);
  const totalEntries = filteredEntries.length;
  const activeEmployees = new Set(filteredEntries.map(e => e.userId)).size;

  return (
    <div className="space-y-4">
      {/* Stats - Compact */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Card className="border-2 border-primary/20 bg-gradient-to-br from-white to-primary/5">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="bg-primary/10 p-2.5 rounded-lg">
                <Calendar className="size-5 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Entries</p>
                <p className="text-2xl font-bold text-foreground">{totalEntries}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-2 border-green-100 bg-gradient-to-br from-white to-green-50">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="bg-green-100 p-2.5 rounded-lg">
                <Clock className="size-5 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Hours</p>
                <p className="text-2xl font-bold text-foreground">{totalHours.toFixed(1)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-2 border-blue-100 bg-gradient-to-br from-white to-blue-50">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="bg-blue-100 p-2.5 rounded-lg">
                <Users className="size-5 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Active Employees</p>
                <p className="text-2xl font-bold text-foreground">{activeEmployees}</p>
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
                <p className="text-xs text-muted-foreground">Flags</p>
                <p className="text-2xl font-bold text-foreground">{totalFlags}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters - Compact */}
      <Card className="border-2 border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="size-4" />
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
              <Card key={entry.id} className="border-2 border-slate-200 hover:border-primary/30 transition-colors">
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
                          <DropdownMenuItem>
                            <Edit className="size-4 mr-2" />
                            Edit Entry
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-red-600">
                            <Trash2 className="size-4 mr-2" />
                            Delete Entry
                          </DropdownMenuItem>
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
    </div>
  );
}