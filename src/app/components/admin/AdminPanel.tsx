import { useState, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import { User } from '../../lib/auth';
import { SectionHelp } from '../ui/section-help';
import { dbService, TimeEntry, TimeSegment, recomputeSegmentSystemTimestamps, stripUndefined, getEntryTotals, computeSegmentWorkMinutes, recalculateEntryTotals } from '../../lib/database';
import { doc, Timestamp, updateDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { repairRunawayShifts, repairDefaultEndDate, REPAIR_DEFAULT_START_DATE, type RepairRunawayResult } from '../../../services/repairRunawayShifts';
import { fetchGlobalSettings, resolveGuardrailLimits, DEFAULT_GUARDRAIL_LIMITS, type GuardrailLimits } from '../../../services/systemSettingsService';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { Checkbox } from '../ui/checkbox';
import { Textarea } from '../ui/textarea';
import { UserAvatar } from '../ui/user-avatar';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { WorkModelOverrideModal } from './WorkModelOverrideModal';
import { toast } from 'sonner';
import { UserPlus, Upload, Download, Edit, Trash2, CheckCircle2, Loader2, UserCheck, UserX, Building2, Laptop, Shield, Filter, Sliders, Briefcase, Settings, Wrench, Plus } from 'lucide-react';

// Existing provisioning logic (keeps admin signed in while creating users)
import { provisionUser } from '../../../services/authService';
import { calculateLunchMinutes, formatHoursHMM } from '../../../utils/timeCalculations';
import { validateSegmentChronology, getFuturePunchError, getSegmentOverlapError } from '../../../utils/timeValidation';
import { calculateDailyOvertimeBreakdown, getWorkWeekStartDate, DEFAULT_WORKWEEK_START_DAY } from '../../../utils/overtimeCalculations';
import { auditLogService } from '../../../services/auditLogService';
import { listWorkModels, type WorkModel as WorkModelDef } from '../../../services/workModelsService';
import { isRemoteWorkModel, resolveWorkModelName } from '../../../utils/workModelUtils';
import { migrateRemotePayCalculationDay, DEFAULT_REMOTE_PAY_CALCULATION_DAY } from '../../../services/userMigrationService';

interface AdminPanelProps {
  currentUser: User;
  allUsers: User[];
  onUsersChange: (users: User[]) => void;
}

type FilterColumn = 'workModel' | 'role' | 'status';

const WORK_MODEL_OPTIONS = [
  { value: 'On-site', label: 'On-site' },
  { value: 'Remote', label: 'Remote' },
];
const ROLE_OPTIONS = [
  { value: 'employee', label: 'Employee' },
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Manager' },
];
const STATUS_OPTIONS = [
  { value: 'Active', label: 'Active' },
  { value: 'Inactive', label: 'Inactive' },
];

// Pay Calculation Day (remotePayCalculationDay): integer day-of-month options
// for Remote employees. 1–28 so the day exists in every month. Default 1
// (matches the value backfilled onto every users doc by the migration).
const PAY_CALCULATION_DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => i + 1);

/**
 * Resolve a user's effective work-model label from a single canonical source.
 *
 * A user has two parallel work-model fields: the legacy `workModel` string
 * ('On-site' / 'Remote') and the newer `workModelId` FK into the workModels
 * collection. Different write paths update only one of them (the override
 * modal writes `workModelId` only; the quick toggle writes `workModel` only),
 * so they can drift. Both the filter and the display pill MUST read the same
 * resolved label or they disagree — which manifested as a user whose model was
 * changed via the override modal still appearing under their old model in the
 * filter (the pill read the fresh `workModelId`; the filter read the stale
 * `workModel` string).
 *
 * Precedence: `workModelId` lookup wins (it's the newer, authoritative FK);
 * falls back to the legacy `workModel` string; then '' (so the filter's
 * default-of-'On-site' / the pill's 'Select Model' each apply their own
 * fallback downstream).
 *
 * The implementation lives in utils/workModelUtils (resolveWorkModelName) and
 * is shared with the Analytics/Payroll Remote-cycle trigger and the edit-open
 * path — a single resolver so the precedence can't drift between copies.
 */
const resolveWorkModelLabel = resolveWorkModelName;

// Customizable columns in the Manage Users table. "User" is intentionally
// excluded — it is always visible and has no explicit width so it auto-fills
// all remaining horizontal space under `table-fixed`. Badge/action columns use
// fixed widths set directly on their <th>; when a column is hidden it is
// removed from the DOM, so its width no longer counts and the User column
// gracefully absorbs the freed space.
type UserColumn = 'workModel' | 'role' | 'status' | 'edit' | 'delete';

const CUSTOMIZABLE_COLUMNS: { key: UserColumn; label: string }[] = [
  { key: 'workModel', label: 'Work Model' },
  { key: 'role', label: 'Role' },
  { key: 'status', label: 'Status' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
];

const DEFAULT_VISIBLE_COLUMNS: Record<UserColumn, boolean> = {
  workModel: true,
  role: true,
  status: true,
  edit: true,
  delete: true,
};

function loadVisibleColumns(uid: string | undefined): Record<UserColumn, boolean> {
  if (!uid) return DEFAULT_VISIBLE_COLUMNS;
  try {
    const saved = localStorage.getItem(`manage_users_visible_cols_${uid}`);
    if (saved) {
      return { ...DEFAULT_VISIBLE_COLUMNS, ...JSON.parse(saved) };
    }
  } catch {
    // Corrupt or unavailable localStorage — fall back to defaults.
  }
  return DEFAULT_VISIBLE_COLUMNS;
}

// Per-admin active header filter selections (Work Model / Role / Status).
// Falls back to "all selected" when no saved key exists or storage is blocked.
function loadActiveFilters(uid: string | undefined): {
  workModels: string[];
  roles: string[];
  statuses: string[];
} {
  const defaults = {
    workModels: WORK_MODEL_OPTIONS.map(o => o.value),
    roles: ROLE_OPTIONS.map(o => o.value),
    statuses: STATUS_OPTIONS.map(o => o.value),
  };
  if (!uid) return defaults;
  try {
    const saved = localStorage.getItem(`manage_users_active_filters_${uid}`);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        workModels: Array.isArray(parsed.workModels) ? parsed.workModels : defaults.workModels,
        roles: Array.isArray(parsed.roles) ? parsed.roles : defaults.roles,
        statuses: Array.isArray(parsed.statuses) ? parsed.statuses : defaults.statuses,
      };
    }
  } catch {
    // Corrupt or unavailable localStorage — fall back to all selected.
  }
  return defaults;
}

function FilterHeader({
  column,
  title,
  options,
  selected,
  setSelected,
  openColumn,
  setOpenColumn,
}: {
  column: FilterColumn;
  title: string;
  options: { value: string; label: string }[];
  selected: string[];
  setSelected: Dispatch<SetStateAction<string[]>>;
  openColumn: FilterColumn | null;
  setOpenColumn: Dispatch<SetStateAction<FilterColumn | null>>;
}) {
  const isOpen = openColumn === column;
  const active = selected.length < options.length;
  const allSelected = selected.length === options.length;

  return (
    <Popover open={isOpen} onOpenChange={(open) => setOpenColumn(open ? column : null)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Filter ${title}`}
          className="inline-flex items-center gap-1 cursor-pointer transition-colors text-muted-foreground font-medium text-xs uppercase tracking-wider"
        >
          <span>{title}</span>
          <Filter className={`size-3.5 ${active ? 'text-indigo-600 fill-indigo-50' : 'text-muted-foreground'}`} />
        </button>
      </PopoverTrigger>
      {/* PopoverContent is portaled to document.body via Radix Portal, so it
          floats above the table/card regardless of ancestor overflow-hidden
          (no clipping) and never forces scrollbars on the table container. */}
      <PopoverContent align="center" className="w-auto min-w-max px-3 py-2">
        <button
          type="button"
          onClick={() => setSelected(allSelected ? [] : options.map(o => o.value))}
          className="text-xs font-medium text-indigo-600 hover:text-indigo-800 mb-2"
        >
          {allSelected ? 'Clear' : 'Select All'}
        </button>
        <div className="flex flex-col">
          {options.map((o) => {
            const checked = selected.includes(o.value);
            return (
              <label key={o.value} className="flex items-center gap-2 cursor-pointer py-1 text-sm text-slate-700">
                <Checkbox checked={checked} onCheckedChange={(c) => setSelected(c ? [...selected, o.value] : selected.filter(v => v !== o.value))} />
                {o.label}
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One editable shift card in the Correct Time Entry modal. */
interface EditableShift {
  /** React key: the persisted segment id, or a generated id for new shifts. */
  key: string;
  clockInManual: string;
  lunchOutManual: string;
  lunchInManual: string;
  clockOutManual: string;
  skipLunch: boolean;
  /** Preserved for local-midnight-split portions (their owning date differs). */
  localDate?: string;
}

/** Two shift cards match when every editable field is identical. */
function shiftsMatch(a: EditableShift, b: EditableShift): boolean {
  return (
    a.key === b.key &&
    a.clockInManual === b.clockInManual &&
    a.lunchOutManual === b.lunchOutManual &&
    a.lunchInManual === b.lunchInManual &&
    a.clockOutManual === b.clockOutManual &&
    a.skipLunch === b.skipLunch &&
    (a.localDate ?? '') === (b.localDate ?? '')
  );
}

/**
 * Build the editable shift cards from a loaded entry: every persisted segment
 * PLUS the synthesized current shift when it is not already covered by the
 * persisted list (same dedup rules as getEntryTotals — open shift or legacy
 * top-level-only shape). This is what makes secondary/split shifts visible
 * and editable instead of silently editing only the first shift.
 */
function buildEditableShifts(entry: TimeEntry): EditableShift[] {
  const toCard = (s: TimeSegment, fallbackKey: string): EditableShift => ({
    key: s.id || fallbackKey,
    clockInManual: s.clockInManual || '',
    lunchOutManual: s.lunchOutManual || '',
    lunchInManual: s.lunchInManual || '',
    clockOutManual: s.clockOutManual || '',
    skipLunch: !!s.skipLunch,
    localDate: s.localDate,
  });
  const persistedSegs = entry.segments ?? [];
  const cards = persistedSegs.map((s, i) => toCard(s, `seg_persisted_${i}`));
  const current = entry.currentSegment;
  if (current) {
    const coveredExact = persistedSegs.some(
      (s) => s.clockInManual === current.clockInManual && s.clockOutManual === current.clockOutManual,
    );
    const coveredSplitChain =
      persistedSegs.length > 0 &&
      persistedSegs[0].clockInManual === current.clockInManual &&
      persistedSegs[persistedSegs.length - 1].clockOutManual === current.clockOutManual;
    if (!coveredExact && !coveredSplitChain) cards.push(toCard(current, 'seg_current'));
  }
  return cards;
}

export function AdminPanel({ currentUser, allUsers, onUsersChange }: AdminPanelProps) {
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [editUserOpen, setEditUserOpen] = useState(false);
  const [correctEntryOpen, setCorrectEntryOpen] = useState(false);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [userToToggleStatus, setUserToToggleStatus] = useState<{ user: User; targetStatus: 'Active' | 'Inactive' } | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [userToToggleWorkModel, setUserToToggleWorkModel] = useState<{ user: User; targetWorkModel: 'On-site' | 'Remote' } | null>(null);
  const [updatingWorkModel, setUpdatingWorkModel] = useState(false);
  const [workModelError, setWorkModelError] = useState<string | null>(null);
  const [workModelOverrideUser, setWorkModelOverrideUser] = useState<User | null>(null);
  const [userToEditRole, setUserToEditRole] = useState<User | null>(null);
  const [selectedRole, setSelectedRole] = useState<User['role'] | null>(null);
  const [updatingRole, setUpdatingRole] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [workModels, setWorkModels] = useState<WorkModelDef[]>([]);

  useEffect(() => {
    listWorkModels().then(setWorkModels).catch(e => console.error('Failed to load work models', e));

    // One-time backfill: physically write remotePayCalculationDay: 1 into
    // every users doc missing it. Idempotent (docs already holding a number
    // are skipped), so running on every admin init is a read-only no-op once
    // all docs are migrated. Admin-only context — firestore.rules requires
    // hasRole('admin') to update other users' docs.
    migrateRemotePayCalculationDay()
      .then(async ({ updated }) => {
        if (updated > 0) {
          onUsersChange(await dbService.getAllUsers());
          toast.success(`Backfilled remotePayCalculationDay for ${updated} user${updated === 1 ? '' : 's'}`);
        }
      })
      .catch(e => console.error('remotePayCalculationDay migration failed', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // Snapshot of the edit form exactly as initialized on open — the dirty
  // baseline for the Save button. Set alongside setEditingUser on open and
  // refreshed after every successful save (same lifecycle as
  // originalCorrectionEntry for the Correct Entry modal).
  const [initialEditingUser, setInitialEditingUser] = useState<User | null>(null);
  // Header filter selections, restored per-admin from localStorage on mount.
  const [initialFilters] = useState(() => loadActiveFilters(currentUser.uid));
  const [selectedWorkModels, setSelectedWorkModels] = useState<string[]>(initialFilters.workModels);
  const [selectedRoles, setSelectedRoles] = useState<string[]>(initialFilters.roles);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>(initialFilters.statuses);
  const [openFilterMenu, setOpenFilterMenu] = useState<FilterColumn | null>(null);
  const [openMobileFilterMenu, setOpenMobileFilterMenu] = useState<FilterColumn | null>(null);

  // Per-admin column visibility, persisted to localStorage by uid.
  const [visibleColumns, setVisibleColumns] = useState<Record<UserColumn, boolean>>(() =>
    loadVisibleColumns(currentUser.uid),
  );
  const [columnSettingsOpen, setColumnSettingsOpen] = useState(false);

  useEffect(() => {
    if (!currentUser.uid) return;
    try {
      localStorage.setItem(
        `manage_users_visible_cols_${currentUser.uid}`,
        JSON.stringify(visibleColumns),
      );
    } catch {
      // Storage unavailable (private mode / quota) — preferences stay in-memory only.
    }
  }, [visibleColumns, currentUser.uid]);

  const toggleColumn = (col: UserColumn) =>
    setVisibleColumns(prev => ({ ...prev, [col]: !prev[col] }));

  // Dynamic, proportional column distribution under `table-fixed`. The User
  // column gets a fixed ~25% share and the remaining ~75% is divided equally
  // among the currently-visible non-User columns. This recomputes whenever a
  // column is toggled, so hiding a column redistributes its space evenly to
  // the rest instead of dumping it all into the User column (the large gap)
  // or bunching the others against the right border. If every non-User column
  // is hidden, User expands to fill the full width.
  const visibleOtherCount = CUSTOMIZABLE_COLUMNS.filter(c => visibleColumns[c.key]).length;
  const userColPct = visibleOtherCount === 0 ? 100 : 25;
  const otherColPct = visibleOtherCount === 0 ? 0 : 75 / visibleOtherCount;

  // Persist active filter selections per-admin so they survive refresh/relogin.
  useEffect(() => {
    if (!currentUser.uid) return;
    try {
      localStorage.setItem(
        `manage_users_active_filters_${currentUser.uid}`,
        JSON.stringify({
          workModels: selectedWorkModels,
          roles: selectedRoles,
          statuses: selectedStatuses,
        }),
      );
    } catch {
      // Storage unavailable (private mode / quota) — filters stay in-memory only.
    }
  }, [selectedWorkModels, selectedRoles, selectedStatuses, currentUser.uid]);

  const [correctionEntry, setCorrectionEntry] = useState<TimeEntry | null>(null);
  const [originalCorrectionEntry, setOriginalCorrectionEntry] = useState<TimeEntry | null>(null);
  const [correctionUserId, setCorrectionUserId] = useState('');
  const [correctionDate, setCorrectionDate] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  // Editable per-shift cards for the Correct Entry modal (multi-segment
  // editing: every shift of the day is visible/editable, not just the first).
  const [correctionSegments, setCorrectionSegments] = useState<EditableShift[]>([]);

  const updateShiftCard = (idx: number, field: keyof EditableShift, value: string | boolean) => {
    setCorrectionSegments((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  };
  const addShiftCard = () => {
    setCorrectionSegments((prev) => [
      ...prev,
      { key: `seg_new_${Date.now()}_${prev.length}`, clockInManual: '', lunchOutManual: '', lunchInManual: '', clockOutManual: '', skipLunch: false },
    ]);
  };
  const removeShiftCard = (idx: number) => {
    setCorrectionSegments((prev) => prev.filter((_, i) => i !== idx));
  };

  // Live "after" preview for the Correct Entry modal: the day total the save
  // will persist, computed from ALL edited shift cards via the canonical
  // computeSegmentWorkMinutes (manual-primary, S6 wrap + lunch deduction) —
  // the same math the read-side SSOT (getEntryTotals) applies, so the preview
  // matches what History/Payroll will show.
  const correctionAfterHours = useMemo(() => {
    if (!correctionEntry) return null;
    const completeCards = correctionSegments.filter((s) => s.clockInManual && s.clockOutManual);
    if (completeCards.length === 0) return null;
    const mins = completeCards.reduce(
      (sum, s) =>
        sum +
        computeSegmentWorkMinutes({
          id: s.key,
          clockInManual: s.clockInManual,
          lunchOutManual: s.skipLunch ? '' : s.lunchOutManual || undefined,
          lunchInManual: s.skipLunch ? '' : s.lunchInManual || undefined,
          clockOutManual: s.clockOutManual,
          skipLunch: s.skipLunch,
          complete: true,
        }),
      0,
    );
    return mins / 60;
  }, [correctionEntry, correctionSegments]);

  // Dirty-state guard for Save Correction. Baseline = the shift cards exactly
  // as loaded from Firestore (rebuilt from originalCorrectionEntry, which is
  // refreshed after every save). The note field always opens empty, so the
  // button enables when any timestamp / segment structure differs OR the
  // admin types a note; reverting all edits with an empty note re-disables it.
  const baselineShifts = useMemo(
    () => (originalCorrectionEntry ? buildEditableShifts(originalCorrectionEntry) : null),
    [originalCorrectionEntry],
  );
  const isCorrectionDirty = useMemo(() => {
    if (!baselineShifts) return false;
    if (adminNotes.trim() !== '') return true;
    if (correctionSegments.length !== baselineShifts.length) return true;
    return correctionSegments.some((s, i) => !shiftsMatch(s, baselineShifts[i]));
  }, [baselineShifts, correctionSegments, adminNotes]);

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

  // Edit User dirty-state: compare each editable field against the open-time
  // snapshot. Optional text fields compare with '' ↔ undefined normalized (the
  // inputs render `value || ''`, so clearing a field back to empty must count
  // as reverted). Pay Calculation Day only participates when the current form
  // work model is Remote — for On-site the field is hidden and never written.
  const isEditUserDirty = useMemo(() => {
    if (!editingUser || !initialEditingUser) return false;
    const norm = (v?: string) => v ?? '';
    return (
      editingUser.name !== initialEditingUser.name ||
      norm(editingUser.work_email) !== norm(initialEditingUser.work_email) ||
      norm(editingUser.phone_number) !== norm(initialEditingUser.phone_number) ||
      norm(editingUser.timezone) !== norm(initialEditingUser.timezone) ||
      !!editingUser.sms_opt_in !== !!initialEditingUser.sms_opt_in ||
      editingUser.workModel !== initialEditingUser.workModel ||
      (editingUser.workModel === 'Remote' &&
        (editingUser.remotePayCalculationDay ?? DEFAULT_REMOTE_PAY_CALCULATION_DAY) !==
          (initialEditingUser.remotePayCalculationDay ?? DEFAULT_REMOTE_PAY_CALCULATION_DAY))
    );
  }, [editingUser, initialEditingUser]);

  const handleEditUser = async () => {
    if (!editingUser || !isEditUserDirty) return;

    try {
      // Keep the two parallel work-model fields consistent on save. workModelId
      // is only rewritten when the admin actually CHANGED the work-model select
      // (editingUser.workModel differs from the open-time snapshot). If the
      // select is untouched, the original workModelId is preserved verbatim —
      // critical for users assigned a CUSTOM-named model (e.g. "Remote East"):
      // the select only offers the two standard labels, so re-deriving the FK
      // from the normalized label would silently clobber the custom FK (and
      // with it the OT/pay-cycle semantics that key off workModelId).
      const workModelChanged = editingUser.workModel !== initialEditingUser?.workModel;
      const chosenWorkModelDef = workModelChanged
        ? workModels.find(m => m.name === editingUser.workModel)
        : undefined;

      const updates: Parameters<typeof dbService.updateUser>[1] = {
        name: editingUser.name,
        work_email: editingUser.work_email,
        phone_number: editingUser.phone_number,
        sms_opt_in: editingUser.sms_opt_in,
        timezone: editingUser.timezone,
        workModel: editingUser.workModel,
        ...(workModelChanged && chosenWorkModelDef ? { workModelId: chosenWorkModelDef.id } : {}),
      };

      // remotePayCalculationDay is written only for Remote users, as a native
      // Firestore number (the <select> yields a string — cast explicitly).
      // On-site saves omit the field entirely: the stored value is preserved
      // untouched, so toggling work model back and forth never corrupts or
      // loses the employee's configured day.
      if (editingUser.workModel === 'Remote') {
        const day = Number(editingUser.remotePayCalculationDay ?? DEFAULT_REMOTE_PAY_CALCULATION_DAY);
        updates.remotePayCalculationDay = Math.min(28, Math.max(1, Math.round(day)));
      }

      const updated = await dbService.updateUser(editingUser.uid, updates);

      onUsersChange(allUsers.map(u => u.uid === updated.uid ? updated : u));
      toast.success('User updated successfully');
      setEditUserOpen(false);
      setEditingUser(null);
      setInitialEditingUser(null);
    } catch (e) {
      console.error('Failed to update user', e);
      toast.error(e instanceof Error ? `Failed to update user: ${e.message}` : 'Failed to update user');
    }
  };

  const confirmDeleteUser = async () => {
    if (!userToDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const uid = userToDelete.uid;
      await dbService.deleteUserProfile(uid);
      onUsersChange(allUsers.filter(u => u.uid !== uid));
      toast.success('User deleted from database');
      setUserToDelete(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to delete user';
      setDeleteError(msg);
      toast.error(msg);
    } finally {
      setDeleting(false);
    }
  };

  const confirmToggleStatus = async () => {
    if (!userToToggleStatus) return;
    setUpdatingStatus(true);
    setStatusError(null);
    try {
      const { user, targetStatus } = userToToggleStatus;
      const updated = await dbService.updateUser(user.uid, {
        active: targetStatus === 'Active',
      });
      onUsersChange(allUsers.map(u => u.uid === updated.uid ? updated : u));
      toast.success(`User ${updated.active ? 'activated' : 'deactivated'}`);
      setUserToToggleStatus(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to update user status';
      setStatusError(msg);
      toast.error(msg);
    } finally {
      setUpdatingStatus(false);
    }
  };

  const confirmToggleWorkModel = async () => {
    if (!userToToggleWorkModel) return;
    setUpdatingWorkModel(true);
    setWorkModelError(null);
    try {
      const { user, targetWorkModel } = userToToggleWorkModel;
      // Keep both fields consistent (see resolveWorkModelLabel): write the
      // matching workModels doc id alongside the legacy string when one
      // exists, so the pill, filter, and Edit modal never disagree.
      const targetDef = workModels.find(m => m.name === targetWorkModel);
      const updated = await dbService.updateUser(user.uid, {
        workModel: targetWorkModel,
        ...(targetDef ? { workModelId: targetDef.id } : {}),
      });
      onUsersChange(allUsers.map(u => u.uid === updated.uid ? updated : u));
      toast.success(`Work model updated to ${targetWorkModel}`);
      setUserToToggleWorkModel(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to update work model';
      setWorkModelError(msg);
      toast.error(msg);
    } finally {
      setUpdatingWorkModel(false);
    }
  };

  const renderWorkModelPill = (user: User) => {
    const label = resolveWorkModelLabel(user, workModels) || 'Select Model';
    const remote = label === 'Remote';
    const hasCustom = !!user.workModelOverride?.hasCustomRules;
    return (
      <button
        type="button"
        title="Edit work model & overtime settings"
        onClick={() => setWorkModelOverrideUser(user)}
        aria-label={`Edit ${user.name} work model and overtime settings`}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold cursor-pointer transition-all duration-150 hover:shadow-xs hover:scale-[1.02] active:scale-95 ${
          remote
            ? 'bg-purple-50 border-purple-300 text-purple-800 hover:bg-purple-100 hover:border-purple-400'
            : 'bg-blue-50 border-blue-300 text-blue-800 hover:bg-blue-100 hover:border-blue-400'
        }`}
      >
        {hasCustom ? (
          <Sliders className="size-3.5 text-amber-500" />
        ) : (
          <Briefcase className={`size-3.5 ${remote ? 'text-purple-500' : 'text-blue-500'}`} />
        )}
        {label}
      </button>
    );
  };

  const confirmUpdateRole = async () => {
    if (!userToEditRole || !selectedRole) return;
    setUpdatingRole(true);
    setRoleError(null);
    try {
      const updated = await dbService.updateUser(userToEditRole.uid, { role: selectedRole });
      onUsersChange(allUsers.map(u => u.uid === updated.uid ? updated : u));
      toast.success(`Role updated to ${selectedRole}`);
      setUserToEditRole(null);
      setSelectedRole(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to update role';
      setRoleError(msg);
      toast.error(msg);
    } finally {
      setUpdatingRole(false);
    }
  };

  const renderRolePill = (user: User) => (
    <button
      type="button"
      title="Click to change user role"
      onClick={() => {
        setUserToEditRole(user);
        setSelectedRole(user.role);
        setRoleError(null);
      }}
      aria-label={`Change ${user.name} role`}
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold capitalize text-slate-700 cursor-pointer hover:bg-slate-100 hover:border-slate-300 hover:shadow-xs transition-all duration-150 active:scale-95"
    >
      <span className="size-2 rounded-full bg-slate-400" />
      {user.role}
    </button>
  );

  const renderStatusPill = (user: User) => {
    const active = user.active;
    return (
      <button
        type="button"
        title="Click to change user status"
        onClick={() => setUserToToggleStatus({ user, targetStatus: active ? 'Inactive' : 'Active' })}
        aria-label={active ? `Deactivate ${user.name}` : `Activate ${user.name}`}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold cursor-pointer transition-all duration-150 hover:shadow-xs hover:scale-[1.02] active:scale-95 ${
          active
            ? 'bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100 hover:border-emerald-400'
            : 'bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200 hover:border-slate-400'
        }`}
      >
        <span className={`size-2 rounded-full ${active ? 'bg-emerald-500' : 'bg-slate-400'}`} />
        {active ? 'Active' : 'Inactive'}
      </button>
    );
  };

  const renderEditButton = (user: User) => (
    <button
      type="button"
      aria-label={`Edit ${user.name}`}
      onClick={() => {
        // Initialize the modal's workModel from the AUTHORITATIVE resolved
        // Remote-ness (workModelId → name wins over the legacy string, via the
        // shared resolver), so the select shows the same value as the table
        // pill and a custom Remote-flavored model (e.g. "Remote East") still
        // reveals the Pay Calculation Day dropdown. The original workModelId is
        // kept on the snapshot so an unchanged save can preserve a custom FK
        // instead of overwriting it with a default model's id.
        const initial = {
          ...user,
          workModel: (isRemoteWorkModel(user, workModels) ? 'Remote' : 'On-site') as User['workModel'],
        };
        setEditingUser(initial);
        setInitialEditingUser(initial);
        setEditUserOpen(true);
      }}
      className="inline-flex items-center justify-center p-2 rounded-lg border border-slate-200 bg-slate-50 text-slate-600 cursor-pointer transition-all duration-150 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-600 hover:shadow-xs active:scale-95"
    >
      <Edit className="size-4" />
    </button>
  );

  const renderDeleteButton = (user: User) => (
    <button
      type="button"
      aria-label={`Delete ${user.name}`}
      onClick={() => setUserToDelete(user)}
      className="inline-flex items-center justify-center p-2 rounded-lg border border-red-200 bg-red-50/60 text-red-600 cursor-pointer transition-all duration-150 hover:bg-red-100 hover:border-red-300 hover:text-red-700 hover:shadow-xs active:scale-95"
    >
      <Trash2 className="size-4" />
    </button>
  );


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
        setCorrectionSegments(buildEditableShifts(entry));
      } else {
        setCorrectionSegments([]);
        toast.error('No entry found for this date');
      }
    } catch {
      toast.error('Failed to load entry');
    }
  };

  // Auto-load: as soon as both User and Date are selected (with the modal
  // open), fetch the entry reactively — no manual "Load Entry" step. Any
  // selection change first clears the previous entry so stale data never
  // shows while the fetch is in flight. Declared after loadCorrectionEntry
  // (const TDZ) and the clearing setState calls are deferred to the effect's
  // async fetch callback boundary.
  useEffect(() => {
    if (!correctEntryOpen || !correctionUserId || !correctionDate) return;
    let cancelled = false;
    (async () => {
      await Promise.resolve(); // yield so the setState calls are async (lint: set-state-in-effect)
      if (cancelled) return;
      setCorrectionEntry(null);
      setOriginalCorrectionEntry(null);
      await loadCorrectionEntry();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctEntryOpen, correctionUserId, correctionDate]);

  const handleSaveCorrection = async () => {
    // Admin notes are OPTIONAL (policy change 2026-08): admin edits no longer
    // require a mandatory audit reason. The immutable audit row is still
    // written (with an empty reason when the note is blank) so the audit
    // trail remains complete. Employee self-edits still require a reason.
    if (!correctionEntry) return;
    const auditReason = adminNotes.trim();

    try {
      // --- Multi-segment validation --------------------------------------
      // Every shift card must be complete + chronologically valid (S6
      // cross-midnight wrap-aware); overlap across cards is checked below.
      if (correctionSegments.length === 0) {
        toast.error('At least one shift is required.');
        return;
      }
      for (let i = 0; i < correctionSegments.length; i++) {
        const c = correctionSegments[i];
        if (!c.clockInManual || !c.clockOutManual) {
          toast.error(`Shift ${i + 1}: Clock In and Clock Out are required`);
          return;
        }
        const errs = validateSegmentChronology(
          {
            clockInManual: c.clockInManual,
            clockOutManual: c.clockOutManual,
            lunchOutManual: c.skipLunch ? '' : c.lunchOutManual,
            lunchInManual: c.skipLunch ? '' : c.lunchInManual,
            skipLunch: c.skipLunch,
          },
          { allowOpen: false },
        );
        if (errs.length) {
          toast.error(`Shift ${i + 1}: ${errs[0]}`);
          return;
        }
      }

      const now = Timestamp.now();
      const correctedUser = allUsers.find(u => u.uid === correctionUserId);
      const correctedTz = correctedUser?.timezone;

      // Build the full segments[] from the cards: manual fields + recomputed
      // *System epochs (the SSOT for instants) per shift, anchored on the
      // card's attributed local date (midnight-split parts keep their own
      // date). recalculateEntryTotals then derives every segment's
      // workMinutes + the day total via the canonical writer.
      const built: TimeSegment[] = correctionSegments.map((c, i) => {
        const base: TimeSegment = {
          id: c.key.startsWith('seg_new_') ? `seg_admin_${now.toMillis()}_${i}` : c.key,
          clockInManual: c.clockInManual,
          lunchOutManual: c.skipLunch ? '' : (c.lunchOutManual || ''),
          lunchInManual: c.skipLunch ? '' : (c.lunchInManual || ''),
          clockOutManual: c.clockOutManual,
          skipLunch: c.skipLunch,
          complete: true,
          ...(c.localDate ? { localDate: c.localDate, splitFromMidnight: true } : {}),
        };
        return correctedTz
          ? recomputeSegmentSystemTimestamps(base, c.localDate ?? correctionEntry.date, correctedTz)
          : base;
      });
      const recalc = recalculateEntryTotals(built);
      const segments = recalc.segments;
      const totalWorkMinutes = recalc.totalWorkMinutes;

      // Future-time guard per shift, cross-shift overlap guard, then the
      // payroll-lock check (doc date + any split-part local dates) — all
      // before the audit write so a rejected correction leaves no audit row.
      for (let i = 0; i < segments.length; i++) {
        const futureError = getFuturePunchError(segments[i], Date.now());
        if (futureError) {
          toast.error(`Shift ${i + 1}: ${futureError}`);
          return;
        }
      }
      const overlapError = getSegmentOverlapError(segments);
      if (overlapError) {
        toast.error(overlapError);
        return;
      }
      await dbService.assertPayrollDatesNotLocked(
        correctionEntry.date,
        ...correctionSegments.map((c) => c.localDate),
      );

      const correctedWorkModel = correctedUser?.workModelId ? workModels.find(m => m.id === correctedUser.workModelId) ?? null : null;
      const ot = calculateDailyOvertimeBreakdown(totalWorkMinutes, correctedWorkModel, correctedUser?.workModelOverride ?? null);
      const workWeekStartDate = getWorkWeekStartDate(correctionEntry.date, DEFAULT_WORKWEEK_START_DAY);

      // === IMMUTABLE AUDIT TRAIL (Phase 1 requirement) ===
      // Build before / after snapshots for defensibility.
      // Source of truth = the original loaded entry (captured at loadCorrectionEntry) + the values the admin is saving.
      const beforeSnapshot = originalCorrectionEntry
        ? JSON.parse(JSON.stringify(originalCorrectionEntry))
        : {};

      // Top-level fields mirror the LAST shift (dual-write convention).
      const last = segments[segments.length - 1];
      const lunchMinutes = calculateLunchMinutes(
        last.skipLunch ? '' : (last.lunchOutManual || ''),
        last.skipLunch ? '' : (last.lunchInManual || ''),
      );
      const lastHasLunch = !last.skipLunch && !!last.lunchOutManual && !!last.lunchInManual;
      const topLevelSystem = correctedTz
        ? stripUndefined({
            clockInSystem: last.clockInSystem,
            clockOutSystem: last.clockOutSystem,
            lunchOutSystem: last.skipLunch ? undefined : last.lunchOutSystem,
            lunchInSystem: last.skipLunch ? undefined : last.lunchInSystem,
            clockInSystemTime: last.clockInSystem != null ? Timestamp.fromMillis(last.clockInSystem) : undefined,
            clockOutSystemTime: last.clockOutSystem != null ? Timestamp.fromMillis(last.clockOutSystem) : undefined,
            lunchOutSystemTime: last.skipLunch || last.lunchOutSystem == null ? undefined : Timestamp.fromMillis(last.lunchOutSystem),
            lunchInSystemTime: last.skipLunch || last.lunchInSystem == null ? undefined : Timestamp.fromMillis(last.lunchInSystem),
          })
        : {};

      // Top-level clock fields must mirror the LAST edited shift card (the
      // dual-write convention used for the Firestore write below). Do NOT
      // spread correctionEntry's stale top-level values — edits now flow
      // through correctionSegments, so correctionEntry still holds the
      // pre-edit strings and would misrepresent the saved state in the
      // immutable audit row.
      const afterSnapshot = {
        ...correctionEntry,
        clockInManual: last.clockInManual,
        lunchOutManual: last.skipLunch ? '' : (last.lunchOutManual || ''),
        lunchInManual: last.skipLunch ? '' : (last.lunchInManual || ''),
        clockOutManual: last.clockOutManual,
        lunchSkipped: !!last.skipLunch,
        lunchMinutes,
        totalWorkMinutes,
        segments,
        ...topLevelSystem,
        ...(lastHasLunch
          ? {}
          : { lunchOutSystem: null, lunchInSystem: null, lunchOutSystemTime: null, lunchInSystemTime: null }),
        regularMinutes: ot.regularMinutes,
        otMinutes: ot.otMinutes,
        doubleTimeMinutes: ot.doubleTimeMinutes,
        workWeekStartDate,
        dayComplete: true,
        currentStep: 'complete',
        status: 'corrected',
        correctedAt: now.toMillis(),
        correctedBy: currentUser.uid,
        correctionNotes: adminNotes.trim(),
      };

      // Write audit log FIRST. This is the non-repudiable record.
      // Admin edits may have an empty reason (policy change 2026-08);
      // employee self-edits still require a non-empty reason.
      await auditLogService.logTimeCorrection({
        actorUid: currentUser.uid,
        actorName: currentUser.name,
        targetId: correctionEntry.id,
        before: beforeSnapshot,
        after: afterSnapshot,
        reason: auditReason,
      });

      // Only after durable audit row exists do we mutate the time record.
      // When the last shift has no lunch, explicitly NULL the top-level lunch
      // *System fields — a prior segment's lunch epoch would otherwise linger
      // (the Audit Viewer showed it as an out-of-order submission stamped
      // before this shift's clock-in).
      await updateDoc(doc(db, 'timeEntries', correctionEntry.id), {
        clockInManual: last.clockInManual,
        lunchOutManual: last.skipLunch ? '' : (last.lunchOutManual || ''),
        lunchInManual: last.skipLunch ? '' : (last.lunchInManual || ''),
        clockOutManual: last.clockOutManual,
        lunchSkipped: !!last.skipLunch,
        lunchMinutes,
        totalWorkMinutes,
        segments: segments.map((s) => stripUndefined(s)),
        ...topLevelSystem,
        ...(lastHasLunch
          ? {}
          : { lunchOutSystem: null, lunchInSystem: null, lunchOutSystemTime: null, lunchInSystemTime: null }),
        regularMinutes: ot.regularMinutes,
        otMinutes: ot.otMinutes,
        doubleTimeMinutes: ot.doubleTimeMinutes,
        workWeekStartDate,
        dayComplete: true,
        currentStep: 'complete',
        correctedAt: now,
        correctedBy: currentUser.uid,
        correctionNotes: adminNotes.trim(),
        status: 'corrected',
        updatedAt: now,
        updatedBy: currentUser.uid,
      });

      toast.success('Entry corrected successfully (audit trail recorded)');
      // Modal stays OPEN after save (2026-08 UX): reload from Firestore so
      // the "before" baseline AND the shift cards reflect exactly what
      // persisted; a follow-up tweak diffs against the persisted state.
      await loadCorrectionEntry();      setAdminNotes('');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to save correction';
      // If audit log itself failed, the error message already explains the safety block.
      toast.error(msg);
    }
  };

  const filteredUsers = allUsers.filter(user => {
    // Resolve the effective work model the SAME way renderWorkModelPill does
    // (workModelId → workModels name lookup, falling back to the legacy
    // workModel string). Previously the filter read only `user.workModel`,
    // which the WorkModelOverrideModal never writes — so changing a user's
    // model via that modal updated the pill but left the filter stale, and a
    // user kept appearing under their old model. Reading one canonical label
    // keeps the filter and the pill in sync regardless of which field changed.
    const effectiveWorkModel = resolveWorkModelLabel(user, workModels) || 'On-site';
    const matchesWorkModel = selectedWorkModels.includes(effectiveWorkModel);
    const matchesRole = selectedRoles.includes(user.role);
    const matchesStatus = selectedStatuses.includes(user.active ? 'Active' : 'Inactive');
    return matchesWorkModel && matchesRole && matchesStatus;
  });

  const resetFilters = () => {
    setSelectedWorkModels(WORK_MODEL_OPTIONS.map(o => o.value));
    setSelectedRoles(ROLE_OPTIONS.map(o => o.value));
    setSelectedStatuses(STATUS_OPTIONS.map(o => o.value));
  };

  // Reset everything: show all columns AND clear all active header filters so
  // all data is visible again. Used by the "Reset Table" button in the Column
  // Visibility popover.
  const resetTable = () => {
    setVisibleColumns({ ...DEFAULT_VISIBLE_COLUMNS });
    resetFilters();
  };

  // One-time historical repair (client-side admin utility — org policy blocks
  // deploying public callable invokers, so this reuses the authenticated admin
  // path like "Correct Entry"): pick a date window, dry-run scan, then apply.
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairStart, setRepairStart] = useState(REPAIR_DEFAULT_START_DATE);
  const [repairEnd, setRepairEnd] = useState(repairDefaultEndDate);
  const [repairPreview, setRepairPreview] = useState<RepairRunawayResult | null>(null);
  const [repairing, setRepairing] = useState(false);
  // Active Automated Actions limits — fetched when the dialog opens so the
  // description quotes the rules the repair will actually apply.
  const [repairLimits, setRepairLimits] = useState<GuardrailLimits>(DEFAULT_GUARDRAIL_LIMITS);
  useEffect(() => {
    if (!repairOpen) return;
    let cancelled = false;
    fetchGlobalSettings()
      .then((s) => { if (!cancelled) setRepairLimits(resolveGuardrailLimits(s)); })
      .catch(() => { if (!cancelled) setRepairLimits(resolveGuardrailLimits(null)); });
    return () => { cancelled = true; };
  }, [repairOpen]);

  const runRepairScan = async () => {
    setRepairing(true);
    setRepairPreview(null);
    try {
      const usersById = new Map(allUsers.map(u => [u.uid, u]));
      const res = await repairRunawayShifts({
        admin: currentUser,
        usersById,
        startDate: repairStart,
        endDate: repairEnd,
        dryRun: true,
      });
      setRepairPreview(res);
      if (!res.repairs.length) {
        toast.info(`No runaway shifts found (${res.scanned} entries scanned).`);
      }
    } catch (e: unknown) {
      console.error('repairRunawayShifts scan failed', e);
      toast.error(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRepairing(false);
    }
  };

  const applyRepairs = async () => {
    if (!repairPreview || !repairPreview.repairs.length) return;
    setRepairing(true);
    try {
      const usersById = new Map(allUsers.map(u => [u.uid, u]));
      const applied = await repairRunawayShifts({
        admin: currentUser,
        usersById,
        startDate: repairStart,
        endDate: repairEnd,
        dryRun: false,
      });
      toast.success(`Repaired ${applied.repaired} runaway shift(s). See audit logs for details.`);
      setRepairPreview(null);
      setRepairOpen(false);
    } catch (e: unknown) {
      console.error('repairRunawayShifts failed', e);
      toast.error(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRepairing(false);
    }
  };

  return (
    <div className="space-y-3">
      <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl overflow-hidden">
        <CardContent className="flex flex-row items-center gap-4 flex-wrap py-4 [&:last-child]:pb-4">
          <CardTitle className="text-slate-800 font-bold whitespace-nowrap">Quick Actions</CardTitle>
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
          <Button variant="outline" onClick={() => setRepairOpen(true)}>
            <Wrench className="size-4 mr-2" />
            Repair Runaway Shifts
          </Button>
          <div className="ml-auto">
            <SectionHelp
              title="Admin Quick Start Guide"
              description="This panel lets you view, edit, and manage users and time entries within the system."
              sections={[
                { title: "Adding Users", content: 'Use "Create New User" to add individuals, or "Bulk Import" to upload a batch via CSV template.' },
                { title: "Fixing Mistakes", content: 'If an employee forgets to clock out, click "Correct Entry" to manually input their times and unblock them.' },
                { title: "Deactivation", content: "Deactivate users instead of deleting them to preserve historical time records and aggregates." },
                { title: "Column Filters", content: "Click the filter icon next to the Work Model, Role, or Status column headers to filter users via multi-select checkboxes." },
              ]}
            />
          </div>
        </CardContent>
      </Card>

      {/* gap-0 overrides the Card base gap-6 (24px flex gap between header and
         content) so the heading-to-table distance is exactly the header pb-[14px]. */}
      <Card className="border border-white/60 shadow-xl bg-white/70 backdrop-blur-xl rounded-2xl overflow-hidden gap-0">
        <CardHeader className="bg-white/40 pt-[14px] pb-[14px]">
          <CardTitle className="text-slate-800 font-bold flex items-center justify-between">
            <span>Manage Users</span>
            <Popover open={columnSettingsOpen} onOpenChange={setColumnSettingsOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 rounded-full text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                  aria-label="Customize columns"
                >
                  <Settings className="size-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={4} className="w-48 p-0 overflow-hidden">
                <div className="bg-indigo-50 border-b border-indigo-100 px-4 py-3">
                  <h3 className="text-sm font-semibold text-indigo-900">Column Visibility</h3>
                </div>
                <div className="px-4 py-3 flex flex-col">
                  {CUSTOMIZABLE_COLUMNS.map(c => (
                    <label key={c.key} className="flex items-center gap-2 cursor-pointer py-1 text-sm text-slate-700">
                      <Checkbox
                        checked={visibleColumns[c.key]}
                        onCheckedChange={() => toggleColumn(c.key)}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
                <div className="border-t border-slate-100 px-4 py-2.5">
                  <Button variant="outline" size="sm" className="w-full h-8 text-xs" onClick={resetTable}>
                    Reset Table
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-0">
          {/* Mobile Filter Bar — mirrors the desktop column-header popovers */}
          <div className="md:hidden flex flex-wrap items-center gap-3">
            <FilterHeader column="workModel" title="Work Model" options={WORK_MODEL_OPTIONS} selected={selectedWorkModels} setSelected={setSelectedWorkModels} openColumn={openMobileFilterMenu} setOpenColumn={setOpenMobileFilterMenu} />
            <FilterHeader column="role" title="Role" options={ROLE_OPTIONS} selected={selectedRoles} setSelected={setSelectedRoles} openColumn={openMobileFilterMenu} setOpenColumn={setOpenMobileFilterMenu} />
            <FilterHeader column="status" title="Status" options={STATUS_OPTIONS} selected={selectedStatuses} setSelected={setSelectedStatuses} openColumn={openMobileFilterMenu} setOpenColumn={setOpenMobileFilterMenu} />
          </div>
          {/* Mobile Card View */}
          <div className="md:hidden space-y-3 mt-4">
            {filteredUsers.length === 0 ? (
              <Card className="border border-white/80 shadow-md bg-white/60 backdrop-blur-md rounded-2xl">
                <CardContent className="py-10 flex flex-col items-center gap-3">
                  <p className="text-sm text-slate-500">No users match your filter criteria.</p>
                  <Button variant="outline" size="sm" onClick={resetFilters}>Reset Filters</Button>
                </CardContent>
              </Card>
            ) : filteredUsers.map(user => (
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
                    <div className="shrink-0 inline-flex items-center gap-1">
                      {visibleColumns.edit && renderEditButton(user)}
                      {visibleColumns.delete && renderDeleteButton(user)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    {visibleColumns.role && renderRolePill(user)}
                    {visibleColumns.workModel && renderWorkModelPill(user)}
                    {visibleColumns.status && renderStatusPill(user)}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Desktop Table View */}
          <div className="hidden md:block border border-indigo-100 rounded-xl bg-white/50 backdrop-blur-sm shadow-inner">
            <Table className="table-fixed w-full">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-left" style={{ width: `${userColPct}%` }}>User</TableHead>
                  {visibleColumns.workModel && (
                    <TableHead className="whitespace-nowrap text-center" style={{ width: `${otherColPct}%` }}>
                      <FilterHeader column="workModel" title="Work Model" options={WORK_MODEL_OPTIONS} selected={selectedWorkModels} setSelected={setSelectedWorkModels} openColumn={openFilterMenu} setOpenColumn={setOpenFilterMenu} />
                    </TableHead>
                  )}
                  {visibleColumns.role && (
                    <TableHead className="whitespace-nowrap text-center" style={{ width: `${otherColPct}%` }}>
                      <FilterHeader column="role" title="Role" options={ROLE_OPTIONS} selected={selectedRoles} setSelected={setSelectedRoles} openColumn={openFilterMenu} setOpenColumn={setOpenFilterMenu} />
                    </TableHead>
                  )}
                  {visibleColumns.status && (
                    <TableHead className="whitespace-nowrap text-center" style={{ width: `${otherColPct}%` }}>
                      <FilterHeader column="status" title="Status" options={STATUS_OPTIONS} selected={selectedStatuses} setSelected={setSelectedStatuses} openColumn={openFilterMenu} setOpenColumn={setOpenFilterMenu} />
                    </TableHead>
                  )}
                  {visibleColumns.edit && (
                    <TableHead className="text-center" style={{ width: `${otherColPct}%` }}>Edit</TableHead>
                  )}
                  {visibleColumns.delete && (
                    <TableHead className="text-center" style={{ width: `${otherColPct}%` }}>Delete</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={1 + CUSTOMIZABLE_COLUMNS.filter(c => visibleColumns[c.key]).length} className="text-center py-10">
                      <div className="flex flex-col items-center gap-3">
                        <p className="text-sm text-slate-500">No users match your filter criteria.</p>
                        <Button variant="outline" size="sm" onClick={resetFilters}>Reset Filters</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : filteredUsers.map(user => (
                  <TableRow key={user.uid} className="hover:bg-muted/50">
                    <TableCell>
                      <div className="flex items-center gap-3 min-w-0">
                        <UserAvatar name={user.name} size="sm" />
                        <span className="font-medium truncate">{user.name}</span>
                      </div>
                    </TableCell>
                    {visibleColumns.workModel && (
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center">
                          {renderWorkModelPill(user)}
                        </div>
                      </TableCell>
                    )}
                    {visibleColumns.role && (
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center">
                          {renderRolePill(user)}
                        </div>
                      </TableCell>
                    )}
                    {visibleColumns.status && (
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center">
                          {renderStatusPill(user)}
                        </div>
                      </TableCell>
                    )}
                    {visibleColumns.edit && (
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center">
                          {renderEditButton(user)}
                        </div>
                      </TableCell>
                    )}
                    {visibleColumns.delete && (
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center">
                          {renderDeleteButton(user)}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Repair Runaway Shifts Dialog */}
      <Dialog open={repairOpen} onOpenChange={setRepairOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Repair Runaway Shifts</DialogTitle>
            <DialogDescription>
              Scan a date window for runaway shifts — open entries past their guardrail cap, and
              completed entries with segments past the cap. Active rules (Settings → Automated
              Actions): on-site shifts past {repairLimits.onsiteLatestAllowedTime} local are recorded
              as {repairLimits.onsiteRecordedTime}; lunches past {repairLimits.onsiteLunchMaxMinutes} min
              are recorded as {repairLimits.onsiteLunchRecordedMinutes} min; remote shifts auto-close
              after {repairLimits.remoteMaxWorkHours}h. Run a dry scan first, then apply. Every repair
              is audit-logged.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="repair-start">Start date</Label>
              <Input
                id="repair-start"
                type="date"
                value={repairStart}
                onChange={(e) => { setRepairStart(e.target.value); setRepairPreview(null); }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repair-end">End date (defaults to today)</Label>
              <Input
                id="repair-end"
                type="date"
                value={repairEnd}
                onChange={(e) => { setRepairEnd(e.target.value); setRepairPreview(null); }}
              />
            </div>
          </div>
          {repairPreview && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              {repairPreview.repairs.length === 0 ? (
                <p className="text-slate-600">
                  No runaway shifts found ({repairPreview.scanned} entries scanned in window).
                </p>
              ) : (
                <>
                  <p className="font-medium text-slate-800 mb-2">
                    {repairPreview.repairs.length} runaway shift(s) found ({repairPreview.scanned} scanned):
                  </p>
                  <ul className="max-h-56 overflow-y-auto space-y-1 text-slate-700">
                    {repairPreview.repairs.map(r => (
                      <li key={r.entryId} className="leading-snug">
                        <span className="font-medium">{r.userName || r.userId}</span>
                        <span className="text-slate-500"> ({r.workModel}{r.wasComplete ? ', completed' : ', open'})</span>
                        {' → '}{(r.totalWorkMinutes / 60).toFixed(2)}h after cap
                        <span className="block text-xs text-slate-500">{r.caps.join('; ')}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={runRepairScan}
              disabled={repairing || !repairStart || !repairEnd}
            >
              {repairing && !repairPreview ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
              Dry Run Scan
            </Button>
            <Button
              onClick={applyRepairs}
              disabled={repairing || !repairPreview || repairPreview.repairs.length === 0}
            >
              {repairing && repairPreview ? <Loader2 className="size-4 mr-2 animate-spin" /> : null}
              Apply Repairs ({repairPreview?.repairs.length ?? 0})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                <Label>Work Model</Label>
                <Select
                  value={editingUser.workModel}
                  onValueChange={(value) => {
                    const workModel = value as User['workModel'];
                    setEditingUser({
                      ...editingUser,
                      workModel,
                      // Switching On-site → Remote: show the dropdown with the
                      // employee's stored day (or the default 1 if none).
                      // Switching Remote → On-site: hide the dropdown and leave
                      // the stored value untouched — never cleared or corrupted.
                      remotePayCalculationDay:
                        workModel === 'Remote'
                          ? (editingUser.remotePayCalculationDay ?? DEFAULT_REMOTE_PAY_CALCULATION_DAY)
                          : editingUser.remotePayCalculationDay,
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WORK_MODEL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {editingUser.workModel === 'Remote' && (
                <div>
                  <Label>Pay Calculation Day</Label>
                  <Select
                    value={String(editingUser.remotePayCalculationDay ?? DEFAULT_REMOTE_PAY_CALCULATION_DAY)}
                    onValueChange={(value) =>
                      // Select values are strings — parse to an integer before
                      // touching state so Firestore always receives a number.
                      setEditingUser({ ...editingUser, remotePayCalculationDay: parseInt(value, 10) })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAY_CALCULATION_DAY_OPTIONS.map((day) => (
                        <SelectItem key={day} value={String(day)}>{day}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
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
            <Button onClick={handleEditUser} disabled={!isEditUserDirty}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Correct Entry Dialog */}
      <Dialog
        open={correctEntryOpen}
        onOpenChange={(open) => {
          setCorrectEntryOpen(open);
          if (!open) {
            // Fresh slate for the next session — Save no longer resets the
            // form (the modal intentionally stays open after saving).
            setCorrectionEntry(null);
            setOriginalCorrectionEntry(null);
            setCorrectionUserId('');
            setCorrectionDate('');
            setAdminNotes('');
          }
        }}
      >
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
                <Label>User</Label>
                <Select value={correctionUserId} onValueChange={setCorrectionUserId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select user" />
                  </SelectTrigger>
                  <SelectContent>
                    {allUsers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(u => (
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
            {correctionEntry && (
              <>
                {/* Multi-segment editing: one card per shift of the day.
                    Each card keeps the chronological 2x2 order: Clock In (TL),
                    Lunch Out (TR), Lunch In (BL), Clock Out (BR). */}
                <div className="space-y-3">
                  {correctionSegments.map((shift, idx) => (
                    <div key={shift.key} className="p-4 border rounded-lg space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold text-slate-700">Shift {idx + 1}</p>
                        <button
                          type="button"
                          aria-label={`Delete shift ${idx + 1}`}
                          disabled={correctionSegments.length <= 1}
                          onClick={() => removeShiftCard(idx)}
                          className="inline-flex items-center justify-center p-1.5 rounded-lg border border-red-200 bg-red-50/60 text-red-600 cursor-pointer transition-all duration-150 hover:bg-red-100 hover:border-red-300 hover:text-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Clock In</Label>
                          <Input
                            type="time"
                            value={shift.clockInManual}
                            onChange={(e) => updateShiftCard(idx, 'clockInManual', e.target.value)}
                          />
                        </div>
                        {!shift.skipLunch && (
                          <div>
                            <Label>Lunch Out</Label>
                            <Input
                              type="time"
                              value={shift.lunchOutManual}
                              onChange={(e) => updateShiftCard(idx, 'lunchOutManual', e.target.value)}
                            />
                          </div>
                        )}
                        {!shift.skipLunch && (
                          <div>
                            <Label>Lunch In</Label>
                            <Input
                              type="time"
                              value={shift.lunchInManual}
                              onChange={(e) => updateShiftCard(idx, 'lunchInManual', e.target.value)}
                            />
                          </div>
                        )}
                        <div>
                          <Label>Clock Out</Label>
                          <Input
                            type="time"
                            value={shift.clockOutManual}
                            onChange={(e) => updateShiftCard(idx, 'clockOutManual', e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={addShiftCard}>
                    <Plus className="size-4 mr-2" />
                    Add Shift
                  </Button>
                </div>
                {originalCorrectionEntry && correctionEntry && (
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 mt-4 space-y-1">
                    <p className="text-sm font-semibold text-slate-700 mb-2">Preview Changes</p>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-slate-500">Total hours before:</span>
                      <span className="font-medium">{formatHoursHMM(getEntryTotals(originalCorrectionEntry).totalHours)}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-indigo-600 font-medium">Total hours after:</span>
                      <span className="font-bold text-indigo-700">{formatHoursHMM(correctionAfterHours ?? getEntryTotals(correctionEntry).totalHours)}</span>
                    </div>
                  </div>
                )}
                <div className="mt-4">
                  <Label>Admin Notes (Optional — becomes the audit reason)</Label>
                  <Textarea
                    value={adminNotes}
                    onChange={(e) => setAdminNotes(e.target.value)}
                    placeholder="Explain the reason for this correction (optional for admin edits)..."
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectEntryOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveCorrection} disabled={!correctionEntry || correctionSegments.length === 0 || !isCorrectionDirty}>
              Save Correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Import Dialog */}
      <BulkImportDialog open={bulkImportOpen} onOpenChange={setBulkImportOpen} currentUser={currentUser} onImportComplete={() => dbService.getAllUsers().then(onUsersChange)} />

      {/* Delete User Confirmation */}
      <AlertDialog
        open={!!userToDelete}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setUserToDelete(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent className="rounded-2xl border-red-100 shadow-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-900 text-xl">
              <Trash2 className="size-6 text-red-500" />
              Delete User
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-600 text-base space-y-2">
              <span className="block">
                Are you sure you want to delete <strong>{userToDelete?.name}</strong>?
                This will remove the Firestore profile.
              </span>
              <span className="block">
                The Auth user must be deleted separately in Firebase Console.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteError && (
            <p className="text-sm text-red-600 -mt-2">{deleteError}</p>
          )}

          <AlertDialogFooter className="mt-6 gap-3 sm:gap-0">
            <AlertDialogCancel
              disabled={deleting}
              className="rounded-xl font-medium sm:w-1/2"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold sm:w-1/2 disabled:opacity-60"
              onClick={async (e) => {
                e.preventDefault();
                await confirmDeleteUser();
              }}
            >
              {deleting ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Trash2 className="size-4 mr-2" />}
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Status Toggle Confirmation */}
      <AlertDialog
        open={!!userToToggleStatus}
        onOpenChange={(open) => {
          if (!open && !updatingStatus) {
            setUserToToggleStatus(null);
            setStatusError(null);
          }
        }}
      >
        <AlertDialogContent
          className={`rounded-2xl border shadow-2xl ${
            userToToggleStatus?.targetStatus === 'Inactive'
              ? 'border-amber-100'
              : 'border-emerald-100'
          }`}
        >
          <AlertDialogHeader>
            <AlertDialogTitle
              className={`flex items-center gap-2 text-xl ${
                userToToggleStatus?.targetStatus === 'Inactive'
                  ? 'text-amber-900'
                  : 'text-emerald-900'
              }`}
            >
              {userToToggleStatus?.targetStatus === 'Inactive' ? (
                <UserX className="size-6 text-amber-500" />
              ) : (
                <UserCheck className="size-6 text-emerald-500" />
              )}
              {userToToggleStatus?.targetStatus === 'Inactive' ? 'Deactivate User' : 'Activate User'}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-600 text-base">
              {userToToggleStatus?.targetStatus === 'Inactive'
                ? <>Are you sure you want to deactivate <strong>{userToToggleStatus?.user.name}</strong>? They will no longer be able to clock in or access employee features.</>
                : <>Are you sure you want to activate <strong>{userToToggleStatus?.user.name}</strong>? They will regain access to clock in and use system features.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {statusError && (
            <p className="text-sm text-red-600 -mt-2">{statusError}</p>
          )}

          <AlertDialogFooter className="mt-6 gap-3 sm:gap-0">
            <AlertDialogCancel
              disabled={updatingStatus}
              className="rounded-xl font-medium sm:w-1/2"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={updatingStatus}
              className={`rounded-xl font-bold sm:w-1/2 text-white disabled:opacity-60 ${
                userToToggleStatus?.targetStatus === 'Inactive'
                  ? 'bg-amber-600 hover:bg-amber-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              }`}
              onClick={async (e) => {
                e.preventDefault();
                await confirmToggleStatus();
              }}
            >
              {updatingStatus ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : userToToggleStatus?.targetStatus === 'Inactive' ? (
                <UserX className="size-4 mr-2" />
              ) : (
                <UserCheck className="size-4 mr-2" />
              )}
              {updatingStatus
                ? 'Updating…'
                : userToToggleStatus?.targetStatus === 'Inactive'
                  ? 'Deactivate'
                  : 'Activate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Work Model Toggle Confirmation */}
      <AlertDialog
        open={!!userToToggleWorkModel}
        onOpenChange={(open) => {
          if (!open && !updatingWorkModel) {
            setUserToToggleWorkModel(null);
            setWorkModelError(null);
          }
        }}
      >
        <AlertDialogContent
          className={`rounded-2xl border shadow-2xl ${
            userToToggleWorkModel?.targetWorkModel === 'Remote'
              ? 'border-purple-100'
              : 'border-blue-100'
          }`}
        >
          <AlertDialogHeader>
            <AlertDialogTitle
              className={`flex items-center gap-2 text-xl ${
                userToToggleWorkModel?.targetWorkModel === 'Remote'
                  ? 'text-purple-900'
                  : 'text-blue-900'
              }`}
            >
              {userToToggleWorkModel?.targetWorkModel === 'Remote' ? (
                <Laptop className="size-6 text-purple-500" />
              ) : (
                <Building2 className="size-6 text-blue-500" />
              )}
              {userToToggleWorkModel?.targetWorkModel === 'Remote'
                ? 'Change Work Model to Remote'
                : 'Change Work Model to On-site'}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-600 text-base">
              Are you sure you want to change <strong>{userToToggleWorkModel?.user.name}</strong>'s work model to{' '}
              {userToToggleWorkModel?.targetWorkModel}?
            </AlertDialogDescription>
          </AlertDialogHeader>

          {workModelError && (
            <p className="text-sm text-red-600 -mt-2">{workModelError}</p>
          )}

          <AlertDialogFooter className="mt-6 gap-3 sm:gap-0">
            <AlertDialogCancel
              disabled={updatingWorkModel}
              className="rounded-xl font-medium sm:w-1/2"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={updatingWorkModel}
              className={`rounded-xl font-bold sm:w-1/2 text-white disabled:opacity-60 ${
                userToToggleWorkModel?.targetWorkModel === 'Remote'
                  ? 'bg-purple-600 hover:bg-purple-700'
                  : 'bg-blue-600 hover:bg-blue-700'
              }`}
              onClick={async (e) => {
                e.preventDefault();
                await confirmToggleWorkModel();
              }}
            >
              {updatingWorkModel ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : userToToggleWorkModel?.targetWorkModel === 'Remote' ? (
                <Laptop className="size-4 mr-2" />
              ) : (
                <Building2 className="size-4 mr-2" />
              )}
              {updatingWorkModel
                ? 'Updating…'
                : userToToggleWorkModel?.targetWorkModel === 'Remote'
                  ? 'Set to Remote'
                  : 'Set to On-site'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Work Model & Overtime Override Modal */}
      <WorkModelOverrideModal
        user={workModelOverrideUser}
        open={!!workModelOverrideUser}
        onOpenChange={(o) => { if (!o) setWorkModelOverrideUser(null); }}
        onUserUpdated={(updated) => onUsersChange(allUsers.map(u => u.uid === updated.uid ? updated : u))}
      />

      {/* Role Change Confirmation */}
      <AlertDialog
        open={!!userToEditRole}
        onOpenChange={(open) => {
          if (!open && !updatingRole) {
            setUserToEditRole(null);
            setSelectedRole(null);
            setRoleError(null);
          }
        }}
      >
        <AlertDialogContent className="rounded-2xl border border-indigo-100 shadow-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-indigo-900 text-xl">
              <Shield className="size-6 text-indigo-500" />
              Change User Role
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-600 text-base">
              Select a new role for <strong>{userToEditRole?.name}</strong>{' '}
              (Current role: <span className="capitalize font-medium">{userToEditRole?.role}</span>):
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-2 -mt-1">
            {(['employee', 'manager', 'admin'] as User['role'][]).map((r) => {
              const isSelected = selectedRole === r;
              return (
                <button
                  key={r}
                  type="button"
                  disabled={updatingRole}
                  onClick={() => setSelectedRole(r)}
                  className={`flex items-center justify-between rounded-xl border px-4 py-2.5 text-sm font-semibold capitalize transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed ${
                    isSelected
                      ? 'border-indigo-400 bg-indigo-50 text-indigo-800 shadow-xs'
                      : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 hover:border-slate-300'
                  }`}
                >
                  {r}
                  {isSelected && <CheckCircle2 className="size-4 text-indigo-600" />}
                </button>
              );
            })}
          </div>

          {roleError && (
            <p className="text-sm text-red-600 -mt-1">{roleError}</p>
          )}

          <AlertDialogFooter className="mt-6 gap-3 sm:gap-0">
            <AlertDialogCancel
              disabled={updatingRole}
              className="rounded-xl font-medium sm:w-1/2"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={updatingRole || !selectedRole || selectedRole === userToEditRole?.role}
              className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold sm:w-1/2 disabled:opacity-60"
              onClick={async (e) => {
                e.preventDefault();
                await confirmUpdateRole();
              }}
            >
              {updatingRole ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Shield className="size-4 mr-2" />}
              {updatingRole ? 'Updating…' : 'Update Role'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    } catch {
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