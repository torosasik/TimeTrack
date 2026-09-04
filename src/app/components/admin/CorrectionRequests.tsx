import { useState, useEffect } from 'react';
import { User } from '../../lib/auth';
import { SectionHelp } from '../ui/section-help';
import { dbService, CorrectionRequest } from '../../lib/database';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Label } from '../ui/label';
import { toast } from 'sonner';
import { FileWarning, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { useExclusionCutoff } from '../../hooks/useExclusionCutoff';
import { filterByExclusionCutoff } from '../../../utils/exclusionFilter';

interface CorrectionRequestsProps {
  currentUser: User;
}

const STATUS_COLORS: Record<CorrectionRequest['status'], string> = {
  Open: 'bg-amber-100 text-amber-800 border-amber-200',
  'In Progress': 'bg-blue-100 text-blue-800 border-blue-200',
  Resolved: 'bg-green-100 text-green-800 border-green-200',
  Rejected: 'bg-red-100 text-red-800 border-red-200',
};

const STATUS_ICONS: Record<CorrectionRequest['status'], React.ReactNode> = {
  Open: <Clock className="size-3" />,
  'In Progress': <Clock className="size-3" />,
  Resolved: <CheckCircle2 className="size-3" />,
  Rejected: <XCircle className="size-3" />,
};

function StatusBadge({ status }: { status: CorrectionRequest['status'] }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[status]}`}>
      {STATUS_ICONS[status]}
      {status}
    </span>
  );
}

function formatDate(dateStr: string): string {
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function formatTimestamp(millis: number): string {
  try {
    return new Date(millis).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return String(millis);
  }
}

/**
 * Extract a single end of a lunch range stored as "HH:MM - HH:MM" (or
 * "Skipped"). part 0 = lunch out, part 1 = lunch in. Returns '--:--' when
 * the field is absent or doesn't contain the requested end.
 */
function parseLunchField(lunch: string | undefined, part: 0 | 1): string {
  if (!lunch) return '--:--';
  if (lunch === 'Skipped') return 'Skipped';
  const parts = lunch.split('-').map((s) => s.trim());
  return parts[part] || '--:--';
}

export function CorrectionRequests({ currentUser }: CorrectionRequestsProps) {
  const isAdminOrManager = currentUser.role === 'admin' || currentUser.role === 'manager';

  const [requests, setRequests] = useState<CorrectionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRequest, setSelectedRequest] = useState<CorrectionRequest | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [newStatus, setNewStatus] = useState<CorrectionRequest['status']>('In Progress');
  const [saving, setSaving] = useState(false);
  const exclusionCutoff = useExclusionCutoff();

  const loadRequests = async () => {
    setLoading(true);
    try {
      let data: CorrectionRequest[];
      if (isAdminOrManager) {
        data = await dbService.getAllCorrectionRequests();
      } else {
        data = await dbService.getCorrectionRequestsForUser(currentUser.uid);
      }
      // Soft exclusion: hide correction requests targeting attendance days on
      // or before the admin's exclusion cutoff (same cutoff as the other
      // analysis tabs). Raw requests remain intact in Firestore.
      setRequests(filterByExclusionCutoff(data, exclusionCutoff, r => r.requested_date));
    } catch (err) {
      console.error('[CorrectionRequests] Failed to load:', err);
      toast.error('Failed to load correction requests.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.uid, exclusionCutoff]);

  const handleOpenResolve = (req: CorrectionRequest) => {
    setSelectedRequest(req);
    // Open → default to In Progress; In Progress → default to Resolved;
    // Resolved/Rejected (edge) → Resolved.
    setNewStatus(req.status === 'Open' ? 'In Progress' : req.status === 'In Progress' ? 'Resolved' : 'Resolved');
    setResolveOpen(true);
  };

  const handleSaveResolution = async () => {
    if (!selectedRequest) return;
    // Resolution note UI removed: saving requires only a status selection.
    // Downstream handlers accept an empty note (the audit reason falls back
    // to a default string so the mandatory-audit-reason rule stays intact).
    setSaving(true);
    try {
      if (newStatus === 'Resolved') {
        // Resolve + apply the time change atomically. If the timeEntries write
        // or audit fails, the request stays un-Resolved and the error surfaces.
        await dbService.resolveCorrectionRequest({
          requestId: selectedRequest.id,
          adminUid: currentUser.uid,
          adminName: currentUser.name,
          newStatus: 'Resolved',
          resolutionNote: '',
        });
        toast.success(`Request resolved — the employee's time entry has been updated.`);
      } else {
        // In Progress / Rejected: update only the request doc.
        const updates: Partial<CorrectionRequest> = {
          status: newStatus,
          updated_by: currentUser.uid,
        };
        await dbService.updateCorrectionRequest(selectedRequest.id, updates);
        toast.success(`Request updated to "${newStatus}".`);
      }
      setResolveOpen(false);
      setSelectedRequest(null);
      await loadRequests();
    } catch (err: unknown) {
      console.error('[CorrectionRequests] Failed to update:', err);
      toast.error((err as Error).message || 'Failed to update request. The time entry was NOT changed.');
    } finally {
      setSaving(false);
    }
  };

  // Actionable, un-actioned requests (Open) surface in the amber card.
  const openCount = requests.filter(r => r.status === 'Open').length;
  const rejectedCount = requests.filter(r => r.status === 'Rejected').length;

  return (
    <div className="space-y-3">
      {/* Summary cards (admin/manager only) */}
      {isAdminOrManager && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card className="border-slate-200">
            <CardContent className="pt-4 [&:last-child]:pb-3">
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Total</p>
              <p className="text-2xl font-bold text-slate-800">{requests.length}</p>
            </CardContent>
          </Card>
          <Card className="border-amber-200 bg-amber-50/40">
            <CardContent className="pt-4 [&:last-child]:pb-3">
              <p className="text-xs text-amber-700 font-medium uppercase tracking-wider">Open</p>
              <p className="text-2xl font-bold text-amber-800">{openCount}</p>
            </CardContent>
          </Card>
          <Card className="border-red-200 bg-red-50/40">
            <CardContent className="pt-4 [&:last-child]:pb-3">
              <p className="text-xs text-red-600 font-medium uppercase tracking-wider">Rejected</p>
              <p className="text-2xl font-bold text-red-600">{rejectedCount}</p>
            </CardContent>
          </Card>
          <Card className="border-green-200 bg-green-50/40">
            <CardContent className="pt-4 [&:last-child]:pb-3">
              <p className="text-xs text-green-700 font-medium uppercase tracking-wider">Resolved</p>
              <p className="text-2xl font-bold text-green-800">
                {requests.filter(r => r.status === 'Resolved').length}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Main table */}
      <Card>
        <CardHeader className="px-6 pt-3 pb-0 -mb-[18px]">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileWarning className="size-4 text-amber-600" />
              {isAdminOrManager ? 'All Correction Requests' : 'My Correction Requests'}
            </CardTitle>
            <SectionHelp
              title="Correction Requests"
              description={
                isAdminOrManager
                  ? 'Review and resolve time correction requests submitted by employees. Select a new status and save.'
                  : 'Submit and track your time correction requests. Admins will review and resolve them.'
              }
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-500 text-sm">
              Loading requests…
            </div>
          ) : requests.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2">
              <FileWarning className="size-8 opacity-40" />
              <p className="text-sm">No correction requests found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50/60">
                    {isAdminOrManager && <TableHead className="text-xs">Employee</TableHead>}
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs">Issue Type</TableHead>
                    <TableHead className="text-xs">Notes</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Submitted</TableHead>
                    {isAdminOrManager && <TableHead className="text-xs text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((req) => (
                    <TableRow key={req.id} className="hover:bg-slate-50/40 transition-colors">
                      {isAdminOrManager && (
                        <TableCell className="font-medium text-sm text-slate-800">
                          {req.employee_name || req.employee_id}
                        </TableCell>
                      )}
                      <TableCell className="text-sm text-slate-700">
                        {formatDate(req.requested_date)}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-slate-100 text-slate-700 font-medium">
                          {req.issue_type}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-slate-600 max-w-xs">
                        <p className="truncate" title={req.notes}>{req.notes}</p>
                        {req.resolution_note && (
                          <p className="text-xs text-green-700 mt-0.5 truncate" title={req.resolution_note}>
                            Resolution: {req.resolution_note}
                          </p>
                        )}
                        {req.rejection_reason && (
                          <p className="text-xs text-red-700 mt-0.5 truncate" title={req.rejection_reason}>
                            Rejected: {req.rejection_reason}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={req.status} />
                      </TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {formatTimestamp(req.created_at)}
                      </TableCell>
                      {currentUser.role === 'admin' && (
                        <TableCell className="text-right">
                          {/* Show Update for actionable statuses; hide only for
                              terminal Resolved/Rejected. */}
                          {(req.status === 'Open' || req.status === 'In Progress') && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                              onClick={() => handleOpenResolve(req)}
                            >
                              Update
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Resolve Dialog */}
      <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Update Correction Request</DialogTitle>
            <DialogDescription>
              {selectedRequest && (
                <>
                  Employee: <strong>{selectedRequest.employee_name}</strong> &bull; Date:{' '}
                  <strong>{formatDate(selectedRequest.requested_date)}</strong>
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {selectedRequest && (
            <div className="space-y-4 py-2">
              {/* Original vs Requested comparison */}
              <div className="bg-slate-50 rounded-lg p-3 text-sm space-y-3 border border-slate-200">
                <div>
                  <p className="font-medium text-slate-700 text-xs uppercase tracking-wider mb-1">Request Details</p>
                  <p className="text-xs text-slate-600"><span className="text-slate-500">Issue:</span> <span className="font-medium">{selectedRequest.issue_type}</span></p>
                  <p className="text-xs text-slate-600"><span className="text-slate-500">Notes:</span> {selectedRequest.notes}</p>
                </div>

                {/* Explicit 4-line Original vs Requested comparison. The
                    Requested side highlights the single field being changed
                    (issue_type) with its suggested_time; others show --:--. */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-0.5">
                    <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-1">Original</p>
                    <p className="text-xs text-slate-700">Clock In: {selectedRequest.original_clock_in || '--:--'}</p>
                    <p className="text-xs text-slate-700">Lunch Out: {parseLunchField(selectedRequest.original_lunch, 0)}</p>
                    <p className="text-xs text-slate-700">Lunch In: {parseLunchField(selectedRequest.original_lunch, 1)}</p>
                    <p className="text-xs text-slate-700">Clock Out: {selectedRequest.original_clock_out || '--:--'}</p>
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-1">Requested</p>
                    <p className={'text-xs ' + (selectedRequest.issue_type === 'Clock In' ? 'font-bold text-indigo-700' : 'text-slate-400')}>
                      Clock In: {selectedRequest.issue_type === 'Clock In' ? (selectedRequest.suggested_time || selectedRequest.requested_clock_in || '--:--') : '--:--'}
                    </p>
                    <p className={'text-xs ' + (selectedRequest.issue_type === 'Lunch Out' ? 'font-bold text-indigo-700' : 'text-slate-400')}>
                      Lunch Out: {selectedRequest.issue_type === 'Lunch Out' ? (selectedRequest.suggested_time || parseLunchField(selectedRequest.requested_lunch, 0) || '--:--') : '--:--'}
                    </p>
                    <p className={'text-xs ' + (selectedRequest.issue_type === 'Lunch In' ? 'font-bold text-indigo-700' : 'text-slate-400')}>
                      Lunch In: {selectedRequest.issue_type === 'Lunch In' ? (selectedRequest.suggested_time || parseLunchField(selectedRequest.requested_lunch, 1) || '--:--') : '--:--'}
                    </p>
                    <p className={'text-xs ' + (selectedRequest.issue_type === 'Clock Out' ? 'font-bold text-indigo-700' : 'text-slate-400')}>
                      Clock Out: {selectedRequest.issue_type === 'Clock Out' ? (selectedRequest.suggested_time || selectedRequest.requested_clock_out || '--:--') : '--:--'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Status selector */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">New Status</Label>
                <Select value={newStatus} onValueChange={(v) => setNewStatus(v as CorrectionRequest['status'])}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="In Progress">In Progress</SelectItem>
                    <SelectItem value="Resolved">Resolved</SelectItem>
                    <SelectItem value="Rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setResolveOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveResolution}
              disabled={saving}
              className={
                newStatus === 'Rejected'
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : newStatus === 'Resolved'
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : 'bg-indigo-600 hover:bg-indigo-700 text-white'
              }
            >
              {saving ? 'Saving…' : `Save — ${newStatus}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
