import { useState, useEffect } from 'react';
import { User } from '../../lib/auth';
import { SectionHelp } from '../ui/section-help';
import { dbService, TimeEntry } from '../../lib/database';
import { doc, getDoc, setDoc, Timestamp, updateDoc } from 'firebase/firestore';
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
import { UserPlus, Upload, Download, Edit, Trash2, UserCog, MoreVertical, CheckCircle2, HelpCircle } from 'lucide-react';

// Existing provisioning logic (keeps admin signed in while creating users)
import { provisionUser } from '../../../services/authService';
import { calculateLunchMinutes, calculateTotalWorkMinutes, validateTimeEntry } from '../../../utils/timeCalculations';
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
    work_email: '',
    phone_number: '',
    sms_opt_in: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [correctionEntry, setCorrectionEntry] = useState<TimeEntry | null>(null);
  const [originalCorrectionEntry, setOriginalCorrectionEntry] = useState<TimeEntry | null>(null);
  const [correctionUserId, setCorrectionUserId] = useState('');
  const [correctionDate, setCorrectionDate] = useState('');
  const [adminNotes, setAdminNotes] = useState('');

  // Settings State
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [systemSettings, setSystemSettings] = useState({
    enable_email_reminders: true,
    enable_sms_reminders: false,
    lunch_reminder_time: '15:00',
    clockout_reminder_time: '18:00',
    longshift_threshold_hours: 10,
    payroll_cycle_type: 'biweekly',
    weekly_start_day: 1,
    biweekly_start_date: '2024-01-01',
    locked_up_to_date: '',
  });
  const [loadingSettings, setLoadingSettings] = useState(false);

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

      // We explicitly update the newly created user doc to contain our new granular fields.
      // (The initial provision User may not include them natively without a signature change).
      if (createdUid) {
        await dbService.updateUser(createdUid, {
          work_email: newUser.work_email || newUser.email,
          phone_number: newUser.phone_number,
          sms_opt_in: newUser.sms_opt_in,
          timezone: newUser.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        const finalRefreshed = await dbService.getAllUsers();
        onUsersChange(finalRefreshed);
      }

      setNewUser({
        name: '',
        email: '',
        password: '',
        role: 'employee',
        active: true,
        sendInvite: false,
        work_email: '',
        phone_number: '',
        sms_opt_in: false,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
        work_email: editingUser.work_email,
        phone_number: editingUser.phone_number,
        sms_opt_in: editingUser.sms_opt_in,
        timezone: editingUser.timezone,
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
        setOriginalCorrectionEntry(JSON.parse(JSON.stringify(entry)));
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

      const entryToValidate: Partial<TimeEntry> = {
        clockInManual: correctionEntry.clockInManual,
        clockOutManual: correctionEntry.clockOutManual,
        lunchOutManual: correctionEntry.skipLunch ? '' : (correctionEntry.lunchOutManual || ''),
        lunchInManual: correctionEntry.skipLunch ? '' : (correctionEntry.lunchInManual || ''),
      };

      const errors = validateTimeEntry(entryToValidate);
      if (errors.length > 0) {
        toast.error(errors[0]);
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
      setOriginalCorrectionEntry(null);
      setCorrectionUserId('');
      setCorrectionDate('');
      setAdminNotes('');
      setCorrectEntryOpen(false);
    } catch (error) {
      toast.error('Failed to save correction');
    }
  };

  const loadSettings = async () => {
    setLoadingSettings(true);
    try {
      const remindersSnap = await getDoc(doc(db, 'systemSettings', 'reminders'));
      const payrollSnap = await getDoc(doc(db, 'systemSettings', 'payroll'));

      let rData: any = {};
      let pData: any = {};

      if (remindersSnap.exists()) rData = remindersSnap.data();
      if (payrollSnap.exists()) pData = payrollSnap.data();

      setSystemSettings({
        enable_email_reminders: rData.enable_email_reminders !== false,
        enable_sms_reminders: rData.enable_sms_reminders === true,
        lunch_reminder_time: rData.lunch_reminder_time || '15:00',
        clockout_reminder_time: rData.clockout_reminder_time || '18:00',
        longshift_threshold_hours: rData.longshift_threshold_hours || 10,
        payroll_cycle_type: pData.payroll_cycle_type || 'biweekly',
        weekly_start_day: pData.weekly_start_day ?? 1,
        biweekly_start_date: pData.biweekly_start_date || '2024-01-01',
        locked_up_to_date: pData.locked_up_to_date || '',
      });
    } catch (e) {
      console.error(e);
      toast.error("Failed to load settings");
    } finally {
      setLoadingSettings(false);
    }
  };

  const handleSaveSettings = async () => {
    try {
      await setDoc(doc(db, 'systemSettings', 'reminders'), {
        enable_email_reminders: systemSettings.enable_email_reminders,
        enable_sms_reminders: systemSettings.enable_sms_reminders,
        lunch_reminder_time: systemSettings.lunch_reminder_time,
        clockout_reminder_time: systemSettings.clockout_reminder_time,
        longshift_threshold_hours: systemSettings.longshift_threshold_hours,
      }, { merge: true });

      await setDoc(doc(db, 'systemSettings', 'payroll'), {
        payroll_cycle_type: systemSettings.payroll_cycle_type,
        weekly_start_day: systemSettings.weekly_start_day,
        biweekly_start_date: systemSettings.biweekly_start_date,
        locked_up_to_date: systemSettings.locked_up_to_date,
        locked_at: Timestamp.now(),
        locked_by: currentUser.uid,
      }, { merge: true });

      toast.success("Settings saved successfully");
      setSettingsOpen(false);
    } catch (e) {
      console.error(e);
      toast.error("Failed to save settings");
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
      {/* Admin Quick Start Guide */}
      <Card className="border border-indigo-200 shadow-xl bg-gradient-to-br from-indigo-50 to-white/80 backdrop-blur-xl rounded-2xl overflow-hidden">
        <CardHeader className="bg-white/40 border-b border-indigo-50 pb-3">
          <CardTitle className="text-indigo-800 font-bold flex items-center gap-2 text-base">
            <HelpCircle className="size-5 text-indigo-500" />
            Admin Quick Start Guide
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 text-sm text-slate-700 space-y-3">
          <p><strong>1. Adding Users:</strong> Use "Create New User" to add individuals, or "Bulk Import" to upload a batch via CSV.</p>
          <p><strong>2. Fixing Mistakes:</strong> If an employee forgets to clock out, their day is marked incomplete. Click "Correct Entry" below to manually input their times and unblock them for the next day.</p>
          <p><strong>3. Deactivation:</strong> When an employee leaves, use "Deactivate" rather than "Delete" to preserve their historical time records.</p>
        </CardContent>
      </Card>

      <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl overflow-hidden">
        <CardHeader className="bg-white/40 border-b border-indigo-50 pb-4">
          <CardTitle className="text-slate-800 font-bold">Quick Actions</CardTitle>
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
            <Button variant="outline" onClick={() => { loadSettings(); setSettingsOpen(true); }}>
              <UserCog className="size-4 mr-2" />
              System Settings
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl overflow-hidden">
        <CardHeader className="bg-white/40 border-b border-indigo-50 pb-4">
          <CardTitle className="text-slate-800 font-bold flex items-center justify-between">
            <span>Manage Users</span>
            <SectionHelp 
              title="User Management"
              description="This panel lets you view, edit, and create employees within the system."
              sections={[
                { title: "Adding Users", content: "Create a new profile or bulk import via CSV template." },
                { title: "Status Toggle", content: "Deactivate users instead of deleting them to preserve historical aggregates." },
                { title: "Actions Menu", content: "Use the three dots menu on the right edge to access Edit or Deactivation." }
              ]}
            />
          </CardTitle>
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
              <Card key={user.uid} className="border border-white/80 shadow-md bg-white/60 backdrop-blur-md rounded-2xl hover:shadow-lg transition-all">
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
          <div className="hidden md:block border border-indigo-100 rounded-xl overflow-hidden bg-white/50 backdrop-blur-sm shadow-inner">
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
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value, work_email: newUser.work_email || e.target.value })}
              />
            </div>
            <div>
              <Label>Work Email (For Reminders)</Label>
              <Input
                type="email"
                placeholder="Optional, defaults to login email"
                value={newUser.work_email}
                onChange={(e) => setNewUser({ ...newUser, work_email: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Phone Number</Label>
                <Input
                  type="tel"
                  placeholder="+15551234567"
                  value={newUser.phone_number}
                  onChange={(e) => setNewUser({ ...newUser, phone_number: e.target.value })}
                />
              </div>
              <div>
                <Label>Timezone</Label>
                <Input
                  value={newUser.timezone}
                  onChange={(e) => setNewUser({ ...newUser, timezone: e.target.value })}
                  placeholder="e.g. America/Los_Angeles"
                />
              </div>
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
            <div className="flex items-center space-x-2">
              <Checkbox
                id="smsOptIn"
                checked={newUser.sms_opt_in}
                onCheckedChange={(checked) => setNewUser({ ...newUser, sms_opt_in: !!checked })}
              />
              <Label htmlFor="smsOptIn">Opted-in to SMS Reminders</Label>
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
                <Label>Login Email (read-only)</Label>
                <Input value={editingUser.email} disabled />
              </div>
              <div>
                <Label>Work Email (For Reminders)</Label>
                <Input
                  type="email"
                  value={editingUser.work_email || ''}
                  onChange={(e) => setEditingUser({ ...editingUser, work_email: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Phone Number</Label>
                  <Input
                    type="tel"
                    placeholder="+15551234567"
                    value={editingUser.phone_number || ''}
                    onChange={(e) => setEditingUser({ ...editingUser, phone_number: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Timezone</Label>
                  <Input
                    value={editingUser.timezone || ''}
                    onChange={(e) => setEditingUser({ ...editingUser, timezone: e.target.value })}
                    placeholder="e.g. America/Los_Angeles"
                  />
                </div>
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
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="editSmsOptIn"
                  checked={editingUser.sms_opt_in || false}
                  onCheckedChange={(checked) => setEditingUser({ ...editingUser, sms_opt_in: !!checked })}
                />
                <Label htmlFor="editSmsOptIn">Opted-in to SMS Reminders</Label>
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
                {originalCorrectionEntry && correctionEntry && (
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 mt-4 space-y-1">
                    <p className="text-sm font-semibold text-slate-700 mb-2">Preview Changes</p>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-500">Total hours before:</span>
                      <span className="font-medium">{dbService.calculateTotalHours(originalCorrectionEntry).toFixed(2)} hrs</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-indigo-600 font-medium">Total hours after:</span>
                      <span className="font-bold text-indigo-700">{dbService.calculateTotalHours(correctionEntry).toFixed(2)} hrs</span>
                    </div>
                  </div>
                )}
                <div className="mt-4">
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

      {/* Settings Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>System Settings</DialogTitle>
            <DialogDescription>
              Configure automated reminders and thresholds globally.
            </DialogDescription>
          </DialogHeader>
          {loadingSettings ? (
            <div className="py-8 text-center text-sm text-slate-500">Loading settings...</div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center space-x-2 border-b pb-4">
                <Checkbox
                  id="globalEmail"
                  checked={systemSettings.enable_email_reminders}
                  onCheckedChange={(checked) => setSystemSettings({ ...systemSettings, enable_email_reminders: !!checked })}
                />
                <Label htmlFor="globalEmail">Enable Email Reminders Globally</Label>
              </div>

              <div className="flex items-center space-x-2 border-b pb-4">
                <Checkbox
                  id="globalSMS"
                  checked={systemSettings.enable_sms_reminders}
                  onCheckedChange={(checked) => setSystemSettings({ ...systemSettings, enable_sms_reminders: !!checked })}
                />
                <Label htmlFor="globalSMS">Enable SMS Reminders Globally</Label>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Lunch Reminder Time</Label>
                  <Input
                    type="time"
                    value={systemSettings.lunch_reminder_time}
                    onChange={(e) => setSystemSettings({ ...systemSettings, lunch_reminder_time: e.target.value })}
                  />
                  <p className="text-xs text-slate-400 mt-1">If they haven't logged lunch out. Based on employee timezone.</p>
                </div>
                <div>
                  <Label>Clock Out Reminder</Label>
                  <Input
                    type="time"
                    value={systemSettings.clockout_reminder_time}
                    onChange={(e) => setSystemSettings({ ...systemSettings, clockout_reminder_time: e.target.value })}
                  />
                  <p className="text-xs text-slate-400 mt-1">If still clocked in. Based on employee timezone.</p>
                </div>
              </div>

              <div>
                <Label>Long Shift Threshold (Hours)</Label>
                <Input
                  type="number"
                  min="1"
                  max="24"
                  value={systemSettings.longshift_threshold_hours}
                  onChange={(e) => setSystemSettings({ ...systemSettings, longshift_threshold_hours: parseFloat(e.target.value) || 10 })}
                />
                <p className="text-xs text-slate-400 mt-1">Warn if continuously clocked in over this amount of hours.</p>
              </div>

              <div className="pt-4 border-t mt-4">
                <h4 className="font-semibold text-slate-800 mb-4">Payroll Settings</h4>
                <div className="space-y-4">
                  <div>
                    <Label>Payroll Cycle Type</Label>
                    <Select
                      value={systemSettings.payroll_cycle_type}
                      onValueChange={(val) => setSystemSettings({ ...systemSettings, payroll_cycle_type: val })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="biweekly">Bi-weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {systemSettings.payroll_cycle_type === 'weekly' && (
                    <div>
                      <Label>Week Start Day</Label>
                      <Select
                        value={systemSettings.weekly_start_day.toString()}
                        onValueChange={(val) => setSystemSettings({ ...systemSettings, weekly_start_day: parseInt(val, 10) })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="0">Sunday</SelectItem>
                          <SelectItem value="1">Monday</SelectItem>
                          <SelectItem value="2">Tuesday</SelectItem>
                          <SelectItem value="3">Wednesday</SelectItem>
                          <SelectItem value="4">Thursday</SelectItem>
                          <SelectItem value="5">Friday</SelectItem>
                          <SelectItem value="6">Saturday</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {systemSettings.payroll_cycle_type === 'biweekly' && (
                    <div>
                      <Label>Cycle Anchor Date</Label>
                      <Input
                        type="date"
                        value={systemSettings.biweekly_start_date}
                        onChange={(e) => setSystemSettings({ ...systemSettings, biweekly_start_date: e.target.value })}
                      />
                      <p className="text-xs text-slate-400 mt-1">Select any date that marks the start of a bi-weekly cycle.</p>
                    </div>
                  )}

                  <div className="pt-2 border-t mt-4">
                    <h4 className="font-semibold text-red-600 mb-3 flex items-center gap-2">
                      Lock Payroll Period
                    </h4>
                    <div className="space-y-3 bg-red-50 p-4 border border-red-100 rounded-lg">
                      <div>
                        <Label className="text-red-900">Lock Entries Up To (Inclusive)</Label>
                        <div className="flex gap-2 mt-1">
                          <Input
                            type="date"
                            value={systemSettings.locked_up_to_date}
                            onChange={(e) => setSystemSettings({ ...systemSettings, locked_up_to_date: e.target.value })}
                            className="border-red-200"
                          />
                        </div>
                        <p className="text-xs text-red-800 mt-2">
                          Setting a date here will prevent any edits or corrections for time entries on or before this date. Clear the date to unlock all periods.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveSettings}>
              Save Settings
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
          <div className="flex items-start justify-between">
            <div>
              <DialogTitle>Bulk Import Users</DialogTitle>
              <DialogDescription>
                Upload a CSV file (Name,Email,Role,Timezone,Password)
              </DialogDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => {
              const csvContent = "data:text/csv;charset=utf-8,Name,Email,Role,Timezone,Password\nJohn Doe,john@example.com,employee,America/Los_Angeles,\n";
              const encodedUri = encodeURI(csvContent);
              const link = document.createElement("a");
              link.setAttribute("href", encodedUri);
              link.setAttribute("download", "time_tracking_users_template.csv");
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            }}>
              <Download className="size-4 mr-2" />
              Template
            </Button>
          </div>
        </DialogHeader>
        <div className="space-y-4">
          {!importResult ? (
            <>
              <Input type="file" accept=".csv" onChange={handleFileChange} disabled={importing} />
              {parsedUsers.length > 0 && (
                <div className="text-sm">
                  <div className="flex items-center justify-between mb-2">
                    <p className="font-semibold text-green-600">{parsedUsers.length} users found in basic CSV scan.</p>
                    {parsedUsers.some(u => u.error) && (
                      <p className="text-xs font-bold text-red-600">Please fix errors below before importing.</p>
                    )}
                  </div>
                  <div className="max-h-40 overflow-y-auto border rounded p-2 text-xs space-y-1">
                    {parsedUsers.map((u, i) => (
                      <div key={i} className={`grid grid-cols-4 gap-2 ${u.error ? 'text-red-600 font-medium' : ''}`}>
                        <span className="truncate">{u.name}</span>
                        <span className="truncate">{u.email}</span>
                        <span className="capitalize">{u.role}</span>
                        <span className="truncate col-span-1 text-[10px]">{u.error ? `Error: ${u.error}` : u.timezone || 'Default TZ'}</span>
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
            <Button onClick={handleImport} disabled={!file || parsedUsers.length === 0 || parsedUsers.some(u => !!u.error) || importing}>
              {importing ? 'Importing...' : 'Import Users'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}