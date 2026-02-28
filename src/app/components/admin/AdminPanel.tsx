import { useState, useEffect } from 'react';
import { User } from '../../lib/auth';
import { dbService, TimeEntry } from '../../lib/database';
import { doc, Timestamp, updateDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Checkbox } from '../ui/checkbox';
import { Textarea } from '../ui/textarea';
import { Badge } from '../ui/badge';
import { UserAvatar } from '../ui/user-avatar';
import { StatusDot } from '../ui/status-dot';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { toast } from 'sonner';
import { UserPlus, Upload, Edit, Trash2, UserCog, MoreVertical, CheckCircle2 } from 'lucide-react';

// Existing provisioning logic (keeps admin signed in while creating users)
import { provisionUser } from '../../../services/authService';
import { calculateLunchMinutes, calculateTotalWorkMinutes } from '../../../utils/timeCalculations';
import { calculateDailyOvertimeBreakdown, getWorkWeekStartDate, DEFAULT_WORKWEEK_START_DAY } from '../../../utils/overtimeCalculations';

interface AdminPanelProps {
  currentUser: User;
  allUsers: User[];
  onUsersChange: (users: User[]) => void;
}

export function AdminPanel({ currentUser, allUsers, onUsersChange }: AdminPanelProps) {
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [editUserOpen, setEditUserOpen] = useState(false);
  const [correctEntryOpen, setCorrectEntryOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);

  const [newUser, setNewUser] = useState({
    name: '',
    email: '',
    password: '',
    role: 'employee' as User['role'],
    active: true,
    sendInvite: false,
  });

  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [correctionEntry, setCorrectionEntry] = useState<TimeEntry | null>(null);
  const [correctionUserId, setCorrectionUserId] = useState('');
  const [correctionDate, setCorrectionDate] = useState('');
  const [adminNotes, setAdminNotes] = useState('');

  const handleCreateUser = async () => {
    if (!newUser.name || !newUser.email) {
      toast.error('Name and email are required');
      return;
    }

    try {
      if (!newUser.sendInvite && !newUser.password) {
        toast.error('Password is required when Send Invitation Email is off');
        return;
      }

      const result = await provisionUser({
        email: newUser.email,
        name: newUser.name,
        role: newUser.role,
        createdByUid: currentUser.uid,
        sendInvite: newUser.sendInvite,
        password: newUser.sendInvite ? null : newUser.password,
      });

      // Ensure desired active flag (provisioning creates active=true by default)
      let createdUid: string | null = result?.uid || null;
      if (!createdUid) {
        const existing = await dbService.getUserByEmail(newUser.email);
        createdUid = existing?.uid || null;
      }
      if (createdUid && newUser.active === false) {
        await dbService.updateUser(createdUid, { active: false });
      }

      const refreshed = await dbService.getAllUsers();
      onUsersChange(refreshed);

      toast.success(newUser.sendInvite ? `User invited: ${newUser.email}` : 'User created successfully');

      setNewUser({
        name: '',
        email: '',
        password: '',
        role: 'employee',
        active: true,
        sendInvite: false,
      });
      setCreateUserOpen(false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to create user';
      toast.error(msg);
    }
  };

  const handleEditUser = async () => {
    if (!editingUser) return;

    try {
      const updated = await dbService.updateUser(editingUser.uid, {
        name: editingUser.name,
        role: editingUser.role,
        active: editingUser.active,
      });

      onUsersChange(allUsers.map(u => u.uid === updated.uid ? updated : u));
      toast.success('User updated successfully');
      setEditUserOpen(false);
      setEditingUser(null);
    } catch (error) {
      toast.error('Failed to update user');
    }
  };

  const handleDeleteUser = async (uid: string) => {
    if (!confirm('Are you sure you want to delete this user? This will remove the Firestore profile. The Auth user must be deleted separately in Firebase Console.')) {
      return;
    }

    try {
      await dbService.deleteUserProfile(uid);
      onUsersChange(allUsers.filter(u => u.uid !== uid));
      toast.success('User deleted from database');
    } catch (error) {
      toast.error('Failed to delete user');
    }
  };

  const handleToggleActive = async (user: User) => {
    try {
      const updated = await dbService.updateUser(user.uid, {
        active: !user.active,
      });
      onUsersChange(allUsers.map(u => u.uid === updated.uid ? updated : u));
      toast.success(`User ${updated.active ? 'activated' : 'deactivated'}`);
    } catch (error) {
      toast.error('Failed to update user status');
    }
  };

  const loadCorrectionEntry = async () => {
    if (!correctionUserId || !correctionDate) {
      toast.error('Select employee and date');
      return;
    }

    try {
      const entry = await dbService.getTimeEntry(correctionUserId, correctionDate);
      if (entry) {
        setCorrectionEntry(entry);
      } else {
        toast.error('No entry found for this date');
      }
    } catch (error) {
      toast.error('Failed to load entry');
    }
  };

  const handleSaveCorrection = async () => {
    if (!correctionEntry || !adminNotes.trim()) {
      toast.error('Admin notes are required');
      return;
    }

    try {
      if (!correctionEntry.clockInManual || !correctionEntry.clockOutManual) {
        toast.error('Clock In and Clock Out are required');
        return;
      }

      const now = Timestamp.now();
      const lunchMinutes = calculateLunchMinutes(
        correctionEntry.skipLunch ? '' : (correctionEntry.lunchOutManual || ''),
        correctionEntry.skipLunch ? '' : (correctionEntry.lunchInManual || '')
      );
      const totalWorkMinutes = calculateTotalWorkMinutes(
        correctionEntry.clockInManual,
        correctionEntry.clockOutManual,
        lunchMinutes
      );
      const ot = calculateDailyOvertimeBreakdown(totalWorkMinutes);
      const workWeekStartDate = getWorkWeekStartDate(correctionEntry.date, DEFAULT_WORKWEEK_START_DAY);

      await updateDoc(doc(db, 'timeEntries', correctionEntry.id), {
        clockInManual: correctionEntry.clockInManual,
        lunchOutManual: correctionEntry.skipLunch ? '' : (correctionEntry.lunchOutManual || ''),
        lunchInManual: correctionEntry.skipLunch ? '' : (correctionEntry.lunchInManual || ''),
        clockOutManual: correctionEntry.clockOutManual,
        lunchSkipped: !!correctionEntry.skipLunch,
        lunchMinutes,
        totalWorkMinutes,
        regularMinutes: ot.regularMinutes,
        otMinutes: ot.otMinutes,
        doubleTimeMinutes: ot.doubleTimeMinutes,
        workWeekStartDate,
        dayComplete: true,
        currentStep: 'complete',
        correctedAt: now,
        correctedBy: currentUser.uid,
        correctionNotes: adminNotes,
        updatedAt: now,
        updatedBy: currentUser.uid,
      } as any);

      toast.success('Entry corrected successfully');
      setCorrectionEntry(null);
      setCorrectionUserId('');
      setCorrectionDate('');
      setAdminNotes('');
      setCorrectEntryOpen(false);
    } catch (error) {
      toast.error('Failed to save correction');
    }
  };

  const filteredUsers = allUsers.filter(user => {
    const matchesSearch = user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.email.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesRole = roleFilter === 'all' || user.role === roleFilter;
    const matchesStatus = statusFilter === 'all' ||
      (statusFilter === 'active' && user.active) ||
      (statusFilter === 'inactive' && !user.active);
    return matchesSearch && matchesRole && matchesStatus;
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setCreateUserOpen(true)}>
              <UserPlus className="size-4 mr-2" />
              Create New User
            </Button>
            <Button variant="outline" onClick={() => setBulkImportOpen(true)}>
              <Upload className="size-4 mr-2" />
              Bulk Import
            </Button>
            <Button variant="outline" onClick={() => setCorrectEntryOpen(true)}>
              <Edit className="size-4 mr-2" />
              Correct Entry
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Manage Users</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
            <div>
              <Label>Filter by Role</Label>
              <Select value={roleFilter} onValueChange={setRoleFilter}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Roles</SelectItem>
                  <SelectItem value="employee">Employee</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Mobile Card View */}
          <div className="md:hidden space-y-3">
            {filteredUsers.map(user => (
              <Card key={user.uid} className="border-2">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <UserAvatar name={user.name} size="md" />
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-base truncate">{user.name}</p>
                        <p className="text-sm text-muted-foreground truncate">{user.email}</p>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shrink-0">
                          <MoreVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setEditingUser(user);
                            setEditUserOpen(true);
                          }}
                        >
                          <Edit className="size-4 mr-2" />
                          Edit User
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleToggleActive(user)}>
                          <UserCog className="size-4 mr-2" />
                          {user.active ? 'Deactivate' : 'Activate'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => handleDeleteUser(user.uid)}
                        >
                          <Trash2 className="size-4 mr-2" />
                          Delete User
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className="capitalize">{user.role}</Badge>
                    <StatusDot
                      status={user.active ? 'active' : 'inactive'}
                      showLabel
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Desktop Table View */}
          <div className="hidden md:block border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.map(user => (
                  <TableRow key={user.uid} className="hover:bg-muted/50">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <UserAvatar name={user.name} size="sm" />
                        <span className="font-medium">{user.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{user.email}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{user.role}</Badge>
                    </TableCell>
                    <TableCell>
                      <StatusDot
                        status={user.active ? 'active' : 'inactive'}
                        showLabel
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                            <MoreVertical className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditingUser(user);
                              setEditUserOpen(true);
                            }}
                          >
                            <Edit className="size-4 mr-2" />
                            Edit User
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleToggleActive(user)}>
                            <UserCog className="size-4 mr-2" />
                            {user.active ? 'Deactivate' : 'Activate'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-600"
                            onClick={() => handleDeleteUser(user.uid)}
                          >
                            <Trash2 className="size-4 mr-2" />
                            Delete User
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Create User Dialog */}
      <Dialog open={createUserOpen} onOpenChange={setCreateUserOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
            <DialogDescription>
              Add a new employee, manager, or admin to the system.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input
                value={newUser.name}
                onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
              />
            </div>
            <div>
              <Label>Email</Label>
              <Input
                type="email"
                value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
              />
            </div>
            <div>
              <Label>Role</Label>
              <Select
                value={newUser.role}
                onValueChange={(value) => setNewUser({ ...newUser, role: value as User['role'] })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="employee">Employee</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="active"
                checked={newUser.active}
                onCheckedChange={(checked) => setNewUser({ ...newUser, active: !!checked })}
              />
              <Label htmlFor="active">Active</Label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="sendInvite"
                checked={newUser.sendInvite}
                onCheckedChange={(checked) => setNewUser({ ...newUser, sendInvite: !!checked })}
              />
              <Label htmlFor="sendInvite">Send Invitation Email</Label>
            </div>
            {!newUser.sendInvite && (
              <div>
                <Label>Password</Label>
                <Input
                  type="password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateUserOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateUser}>Create User</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={editUserOpen} onOpenChange={setEditUserOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update user information and permissions.
            </DialogDescription>
          </DialogHeader>
          {editingUser && (
            <div className="space-y-4">
              <div>
                <Label>Name</Label>
                <Input
                  value={editingUser.name}
                  onChange={(e) => setEditingUser({ ...editingUser, name: e.target.value })}
                />
              </div>
              <div>
                <Label>Email (read-only)</Label>
                <Input value={editingUser.email} disabled />
              </div>
              <div>
                <Label>Role</Label>
                <Select
                  value={editingUser.role}
                  onValueChange={(value) => setEditingUser({ ...editingUser, role: value as User['role'] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="employee">Employee</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="editActive"
                  checked={editingUser.active}
                  onCheckedChange={(checked) => setEditingUser({ ...editingUser, active: !!checked })}
                />
                <Label htmlFor="editActive">Active</Label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUserOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEditUser}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Correct Entry Dialog */}
      <Dialog open={correctEntryOpen} onOpenChange={setCorrectEntryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Correct Time Entry</DialogTitle>
            <DialogDescription>
              Make administrative corrections to employee time entries.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Employee</Label>
                <Select value={correctionUserId} onValueChange={setCorrectionUserId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select employee" />
                  </SelectTrigger>
                  <SelectContent>
                    {allUsers.filter(u => u.role === 'employee').map(u => (
                      <SelectItem key={u.uid} value={u.uid}>{u.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={correctionDate}
                  onChange={(e) => setCorrectionDate(e.target.value)}
                />
              </div>
            </div>
            <Button onClick={loadCorrectionEntry} variant="outline">
              Load Entry
            </Button>

            {correctionEntry && (
              <>
                <div className="grid grid-cols-2 gap-4 p-4 border rounded-lg">
                  <div>
                    <Label>Clock In</Label>
                    <Input
                      type="time"
                      value={correctionEntry.clockInManual || ''}
                      onChange={(e) => setCorrectionEntry({ ...correctionEntry, clockInManual: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Clock Out</Label>
                    <Input
                      type="time"
                      value={correctionEntry.clockOutManual || ''}
                      onChange={(e) => setCorrectionEntry({ ...correctionEntry, clockOutManual: e.target.value })}
                    />
                  </div>
                  {!correctionEntry.skipLunch && (
                    <>
                      <div>
                        <Label>Lunch Out</Label>
                        <Input
                          type="time"
                          value={correctionEntry.lunchOutManual || ''}
                          onChange={(e) => setCorrectionEntry({ ...correctionEntry, lunchOutManual: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>Lunch In</Label>
                        <Input
                          type="time"
                          value={correctionEntry.lunchInManual || ''}
                          onChange={(e) => setCorrectionEntry({ ...correctionEntry, lunchInManual: e.target.value })}
                        />
                      </div>
                    </>
                  )}
                </div>
                <div>
                  <Label>Admin Notes (Required)</Label>
                  <Textarea
                    value={adminNotes}
                    onChange={(e) => setAdminNotes(e.target.value)}
                    placeholder="Explain the reason for this correction..."
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectEntryOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveCorrection} disabled={!correctionEntry || !adminNotes.trim()}>
              Save Correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Import Dialog */}
      <BulkImportDialog open={bulkImportOpen} onOpenChange={setBulkImportOpen} currentUser={currentUser} onImportComplete={() => dbService.getAllUsers().then(onUsersChange)} />
    </div>
  );
}

// Sub-component for Bulk Import logic to keep main file cleaner
import { parseUserCSV, processUserImport, UserImportData } from '../../../services/bulkImportService';

function BulkImportDialog({ open, onOpenChange, currentUser, onImportComplete }: { open: boolean; onOpenChange: (o: boolean) => void; currentUser: User; onImportComplete: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [parsedUsers, setParsedUsers] = useState<UserImportData[]>([]);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [importResult, setImportResult] = useState<{ success: number; failed: number } | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      const text = await f.text();
      const users = parseUserCSV(text);
      setParsedUsers(users);
      setImportResult(null);
    }
  };

  const handleImport = async () => {
    if (parsedUsers.length === 0) return;
    setImporting(true);
    setProgress(0);
    try {
      const result = await processUserImport(
        parsedUsers,
        currentUser.uid,
        (current, total) => setProgress(Math.round((current / total) * 100))
      );
      setImportResult({ success: result.success, failed: result.failed });
      if (result.success > 0) {
        onImportComplete();
      }
      toast.success(`Import complete: ${result.success} created, ${result.failed} failed`);
    } catch (e) {
      toast.error('Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => {
      if (!importing) {
        onOpenChange(v);
        // Reset state on close
        if (!v) {
          setFile(null);
          setParsedUsers([]);
          setImportResult(null);
          setProgress(0);
        }
      }
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk Import Users</DialogTitle>
          <DialogDescription>
            Upload a CSV file (Name,Email,Role,Password or invite)
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!importResult ? (
            <>
              <Input type="file" accept=".csv" onChange={handleFileChange} disabled={importing} />
              {parsedUsers.length > 0 && (
                <div className="text-sm">
                  <p className="font-semibold text-green-600 mb-2">{parsedUsers.length} users found in basic CSV scan.</p>
                  <div className="max-h-40 overflow-y-auto border rounded p-2 text-xs space-y-1">
                    {parsedUsers.map((u, i) => (
                      <div key={i} className="grid grid-cols-3 gap-2">
                        <span className="truncate">{u.name}</span>
                        <span className="truncate">{u.email}</span>
                        <span className="capitalize">{u.role}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {importing && (
                <div className="space-y-1">
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-600 transition-all duration-300" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="text-xs text-center text-muted-foreground">{progress}% processed</p>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-4 space-y-2">
              <CheckCircle2 className="size-12 text-green-600 mx-auto" />
              <p className="text-lg font-bold">Import Complete</p>
              <div className="flex justify-center gap-4 text-sm">
                <span className="text-green-700">{importResult.success} Success</span>
                <span className="text-red-700">{importResult.failed} Failed</span>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>
            {importResult ? 'Close' : 'Cancel'}
          </Button>
          {!importResult && (
            <Button onClick={handleImport} disabled={!file || parsedUsers.length === 0 || importing}>
              {importing ? 'Importing...' : 'Import Users'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}