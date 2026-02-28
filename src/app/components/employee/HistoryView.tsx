import { useState, useEffect } from 'react';
import { User } from '../../lib/auth';
import { TimeEntry, dbService } from '../../lib/database';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { ArrowLeft, AlertTriangle, Clock, Calendar, Target, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';

interface HistoryViewProps {
  user: User;
  onBack: () => void;
}

type PeriodFilter = 'last-month' | 'this-month' | 'custom';

export function HistoryView({ user, onBack }: HistoryViewProps) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>('this-month');
  const [currentPage, setCurrentPage] = useState(1);
  const entriesPerPage = 10;

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const data = await dbService.getTimeEntriesForUser(user.uid);
      setEntries(data);
    } catch (error) {
      toast.error('Failed to load history');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
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

  const formatHoursMinutes = (hours: number) => {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}h ${m.toString().padStart(2, '0')}m`;
  };

  // Calculate stats
  const totalHours = entries.reduce((acc, e) => acc + (e.totalHours || 0), 0);
  const daysWorked = entries.filter(e => e.complete).length;
  const avgDaily = daysWorked > 0 ? totalHours / daysWorked : 0;

  // Pagination
  const totalPages = Math.ceil(entries.length / entriesPerPage);
  const startIndex = (currentPage - 1) * entriesPerPage;
  const endIndex = startIndex + entriesPerPage;
  const paginatedEntries = entries.slice(startIndex, endIndex);

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
        <p className="mt-4 text-muted-foreground">Loading...</p>
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
        <div className="flex items-center gap-1.5 bg-muted/50 p-1 rounded-lg overflow-x-auto">
          <Button
            variant={periodFilter === 'last-month' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setPeriodFilter('last-month')}
            className="whitespace-nowrap text-xs md:text-sm h-10 md:h-9"
          >
            Last Month
          </Button>
          <Button
            variant={periodFilter === 'this-month' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setPeriodFilter('this-month')}
            className="whitespace-nowrap text-xs md:text-sm h-10 md:h-9"
          >
            This Month
          </Button>
          <Button
            variant={periodFilter === 'custom' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setPeriodFilter('custom')}
            className="whitespace-nowrap text-xs md:text-sm h-10 md:h-9"
          >
            Custom
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
        <Card>
          <CardContent className="pt-4 md:pt-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="bg-primary/10 p-2 md:p-2.5 rounded-lg">
                <Clock className="size-4 md:size-5 text-primary" />
              </div>
              <span className="text-xs md:text-sm text-muted-foreground">Total Hours</span>
            </div>
            <p className="text-2xl md:text-3xl font-bold text-foreground">{formatHoursMinutes(totalHours)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 md:pt-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="bg-primary/10 p-2 md:p-2.5 rounded-lg">
                <Calendar className="size-4 md:size-5 text-primary" />
              </div>
              <span className="text-xs md:text-sm text-muted-foreground">Days Worked</span>
            </div>
            <p className="text-2xl md:text-3xl font-bold text-foreground">{daysWorked}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 md:pt-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="bg-primary/10 p-2 md:p-2.5 rounded-lg">
                <Target className="size-4 md:size-5 text-primary" />
              </div>
              <span className="text-xs md:text-sm text-muted-foreground">Avg. Daily</span>
            </div>
            <p className="text-2xl md:text-3xl font-bold text-foreground">{formatHoursMinutes(avgDaily)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Entries - Mobile Cards / Desktop Table */}
      {paginatedEntries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Clock className="size-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No time entries yet</p>
          </CardContent>
        </Card>
      ) : (
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
          <Card className="hidden md:block">
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>DATE</TableHead>
                    <TableHead>CLOCK IN</TableHead>
                    <TableHead>LUNCH</TableHead>
                    <TableHead>CLOCK OUT</TableHead>
                    <TableHead>NOTES</TableHead>
                    <TableHead className="text-right">TOTAL HOURS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedEntries.map((entry) => {
                    const hasWarning = !entry.clockOutManual;
                    const hasFlags = entry.flags && entry.flags.length > 0;

                    return (
                      <TableRow key={entry.id} className="hover:bg-muted/30">
                        <TableCell className="font-medium">
                          {formatDate(entry.date)}
                        </TableCell>
                        <TableCell>{formatTime(entry.clockInManual)}</TableCell>
                        <TableCell>{formatLunchDuration(entry)}</TableCell>
                        <TableCell>
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
                        <TableCell className="text-right">
                          {entry.totalHours ? (
                            <span className="font-semibold text-primary">
                              {formatHoursMinutes(entry.totalHours)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Incomplete</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
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