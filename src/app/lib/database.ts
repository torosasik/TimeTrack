import { collection, doc, getDoc, getDocs, orderBy, query, Timestamp, updateDoc, where, limit, deleteDoc, addDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import type { User } from './auth';

/**
 * A single continuous work session ("shift"). A day may contain multiple
 * segments when the user pauses and resumes work (split shifts).
 * Legacy single-entry docs with no `segments[]` behave as a single-segment day.
 */
export interface TimeSegment {
  id: string;               // stable per-segment id (timestamp-based)
  clockInManual?: string;
  clockInSystem?: number;
  lunchOutManual?: string;
  lunchOutSystem?: number;
  lunchInManual?: string;
  lunchInSystem?: number;
  clockOutManual?: string;
  clockOutSystem?: number;
  skipLunch?: boolean;
  workMinutes?: number;     // minutes worked in this segment
  complete?: boolean;       // clockOut recorded
  taskId?: string;          // Dragme task id (optional)
  autoClosed?: boolean;     // set when watchdog auto-closes the segment
}

export interface TimeEntry {
  id: string;               // Firestore doc id (uid_date)
  userId: string;
  date: string;             // YYYY-MM-DD

  /** Split-shift segments for the day. Always populated (at least 1 for legacy). */
  segments?: TimeSegment[];

  clockInManual?: string;
  clockInSystem?: number;   // millis
  lunchOutManual?: string;
  lunchOutSystem?: number;  // millis
  lunchInManual?: string;
  lunchInSystem?: number;   // millis
  clockOutManual?: string;

  // Notification system locks to prevent repeated spams per day
  lunch_reminder_sent_at?: any;
  clockout_reminder_sent_at?: any;
  longshift_reminder_sent_at?: any;
  clockOutSystem?: number;  // millis

  skipLunch?: boolean;

  // Raw minutes stored in Firestore (used for payroll/audit calculations)
  totalWorkMinutes?: number;
  regularMinutes?: number;
  otMinutes?: number;
  doubleTimeMinutes?: number;

  totalHours?: number;
  regularHours?: number;
  overtimeHours?: number;   // 1.5x
  doubleTimeHours?: number; // 2x

  complete: boolean;
  flags?: string[];
  adminNotes?: string;
  currentStep: number;      // 0-4 (UI convenience)

  correctionRequested?: boolean;
  anomalyFlag?: boolean;

  completedAt?: number;     // millis
}

export interface CorrectionRequest {
  id: string;
  employee_id: string;
  employee_name: string;
  requested_date: string;       // YYYY-MM-DD
  issue_type: string;
  notes: string;
  suggested_time?: string;

  // Before/After comparison
  original_clock_in?: string;
  original_clock_out?: string;
  original_lunch?: string;
  requested_clock_in?: string;
  requested_clock_out?: string;
  requested_lunch?: string;

  status: 'Open' | 'In Progress' | 'Resolved' | 'Rejected';
  resolution_note?: string;
  rejection_reason?: string;
  created_at: number;           // millis
  updated_at?: number;
  updated_by?: string;
}

type FirestoreTimeEntry = any;

function tsToMillis(ts: unknown): number | undefined {
  if (!ts) return undefined;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  if (ts && typeof (ts as any).toDate === 'function') return (ts as any).toDate().getTime();
  return undefined;
}

function minutesToHours(mins: unknown): number | undefined {
  if (mins === null || mins === undefined) return undefined;
  const n = Number(mins);
  if (Number.isNaN(n)) return undefined;
  return n / 60;
}

/** Compute minutes for the currently-active segment using its clock/lunch fields. */
function deriveCurrentSegmentMinutes(e: Partial<TimeEntry>, archived: TimeSegment[]): number | undefined {
  // If totalWorkMinutes is present and this is a fresh single-segment doc, prefer it minus archived.
  if (!e.clockInManual) return undefined;
  if (e.clockOutManual) {
    const [h1, m1] = e.clockInManual.split(':').map(Number);
    const [h2, m2] = e.clockOutManual.split(':').map(Number);
    let mins = (h2 * 60 + m2) - (h1 * 60 + m1);
    if (!e.skipLunch && e.lunchOutManual && e.lunchInManual) {
      const [lOh, lOm] = e.lunchOutManual.split(':').map(Number);
      const [lIh, lIm] = e.lunchInManual.split(':').map(Number);
      mins -= ((lIh * 60 + lIm) - (lOh * 60 + lOm));
    }
    return Math.max(0, mins);
  }
  return undefined;
}

function mapEntry(id: string, data: FirestoreTimeEntry): TimeEntry {
  const date = String(data.workDate || data.date || '');
  const currentStepRaw = data.currentStep;
  const complete = data.dayComplete === true;
  const skipLunch = data.lunchSkipped === true;
  const currentStep =
    complete || currentStepRaw === 'complete'
      ? 4
      : typeof currentStepRaw === 'number'
        ? Math.max(0, Math.min(3, currentStepRaw - 1))
        : 0;

  const entry: TimeEntry = {
    id,
    userId: String(data.userId || ''),
    date,
    clockInManual: data.clockInManual || undefined,
    clockInSystem: tsToMillis(data.clockInSystemTime),
    lunchOutManual: data.lunchOutManual || undefined,
    lunchOutSystem: tsToMillis(data.lunchOutSystemTime),
    lunchInManual: data.lunchInManual || undefined,
    lunchInSystem: tsToMillis(data.lunchInSystemTime),
    clockOutManual: data.clockOutManual || undefined,
    lunch_reminder_sent_at: data.lunch_reminder_sent_at || null,
    clockout_reminder_sent_at: data.clockout_reminder_sent_at || null,
    longshift_reminder_sent_at: data.longshift_reminder_sent_at || null,
    clockOutSystem: tsToMillis(data.clockOutSystemTime),
    skipLunch,
    totalWorkMinutes: typeof data.totalWorkMinutes === 'number' ? data.totalWorkMinutes : undefined,
    regularMinutes: typeof data.regularMinutes === 'number' ? data.regularMinutes : undefined,
    otMinutes: typeof data.otMinutes === 'number' ? data.otMinutes : undefined,
    doubleTimeMinutes: typeof data.doubleTimeMinutes === 'number' ? data.doubleTimeMinutes : undefined,
    totalHours: minutesToHours(data.totalWorkMinutes),
    regularHours: minutesToHours(data.regularMinutes),
    overtimeHours: minutesToHours(data.otMinutes),
    doubleTimeHours: minutesToHours(data.doubleTimeMinutes),
    complete,
    currentStep,
    adminNotes: data.correctionNotes || data.notes || undefined,
    correctionRequested: data.correctionRequested === true,
    anomalyFlag: data.anomaly_flag === true,
    completedAt: tsToMillis(data.completedAt),
  };

  // --- Split-shift segments ---------------------------------------------
  // Firestore stores *archived* segments in `segments[]`; the current (active
  // or most-recently-completed) segment lives in the legacy top-level fields.
  // Hydrated entry.segments = [...archived, current (if present)].
  const archivedRaw = Array.isArray(data.segments) ? data.segments : [];
  const archived: TimeSegment[] = archivedRaw.map((s: any, i: number) => ({
    id: String(s.id ?? `${id}_arch_${i}`),
    clockInManual: s.clockInManual || undefined,
    clockInSystem: tsToMillis(s.clockInSystemTime ?? s.clockInSystem),
    lunchOutManual: s.lunchOutManual || undefined,
    lunchOutSystem: tsToMillis(s.lunchOutSystemTime ?? s.lunchOutSystem),
    lunchInManual: s.lunchInManual || undefined,
    lunchInSystem: tsToMillis(s.lunchInSystemTime ?? s.lunchInSystem),
    clockOutManual: s.clockOutManual || undefined,
    clockOutSystem: tsToMillis(s.clockOutSystemTime ?? s.clockOutSystem),
    skipLunch: s.skipLunch === true || s.lunchSkipped === true,
    workMinutes: typeof s.workMinutes === 'number' ? s.workMinutes : undefined,
    complete: true,
    taskId: s.taskId || undefined,
    autoClosed: s.autoClosed === true,
  }));

  const current: TimeSegment | null = entry.clockInManual
    ? {
        id: `${id}_current`,
        clockInManual: entry.clockInManual,
        clockInSystem: entry.clockInSystem,
        lunchOutManual: entry.lunchOutManual,
        lunchOutSystem: entry.lunchOutSystem,
        lunchInManual: entry.lunchInManual,
        lunchInSystem: entry.lunchInSystem,
        clockOutManual: entry.clockOutManual,
        clockOutSystem: entry.clockOutSystem,
        skipLunch: entry.skipLunch,
        workMinutes: deriveCurrentSegmentMinutes(entry, archived),
        complete: !!entry.clockOutManual,
        taskId: data.taskId || undefined,
        autoClosed: data.autoClosed === true,
      }
    : null;

  entry.segments = current ? [...archived, current] : archived;

  // Override day-level hours to include all archived segments too.
  if (archived.length > 0) {
    const archivedMins = archived.reduce((s, x) => s + (x.workMinutes || 0), 0);
    const currentMins = current?.workMinutes ?? 0;
    entry.totalWorkMinutes = archivedMins + currentMins;
    entry.totalHours = entry.totalWorkMinutes / 60;
  }

  // Flags are not stored in Firestore by default; compute basic flags for UI
  entry.flags = calculateFlags(entry);
  return entry;
}

/** Returns the currently-active (open, not yet clocked-out) segment, if any. */
export function getActiveSegment(entry: TimeEntry | null | undefined): TimeSegment | null {
  if (!entry?.segments?.length) return null;
  const last = entry.segments[entry.segments.length - 1];
  return last && !last.complete ? last : null;
}

/** True if the day has any open (in-progress) segment. */
export function hasOpenSegment(entry: TimeEntry | null | undefined): boolean {
  return getActiveSegment(entry) !== null;
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function calculateTotalHours(entry: Partial<TimeEntry>): number {
  if (!entry.clockInManual || !entry.clockOutManual) return 0;
  const clockIn = timeToMinutes(entry.clockInManual);
  const clockOut = timeToMinutes(entry.clockOutManual);
  let totalMinutes = clockOut - clockIn;
  if (entry.lunchOutManual && entry.lunchInManual && !entry.skipLunch) {
    totalMinutes -= (timeToMinutes(entry.lunchInManual) - timeToMinutes(entry.lunchOutManual));
  }
  return Math.max(0, totalMinutes / 60);
}

export function calculateFlags(entry: TimeEntry): string[] {
  const flags: string[] = [];
  if (!entry.complete) return flags;

  // Short/long lunch
  if (entry.lunchOutManual && entry.lunchInManual && !entry.skipLunch) {
    const duration = timeToMinutes(entry.lunchInManual) - timeToMinutes(entry.lunchOutManual);
    if (duration < 20) flags.push('short_lunch');
    if (duration > 90) flags.push('long_lunch');
  }

  // Very long/short day
  if (entry.totalHours !== undefined) {
    if (entry.totalHours > 11) flags.push('very_long_day');
    if (entry.totalHours > 0 && entry.totalHours < 4) flags.push('very_short_day');
  }

  // Anomalies detected at submission time by the user bypassing warnings
  if (entry.anomalyFlag) {
    flags.push('anomaly_detected');
  }

  return flags;
}

class DatabaseService {
  calculateTotalHours(entry: Partial<TimeEntry>): number {
    return calculateTotalHours(entry);
  }

  calculateFlags(entry: TimeEntry): string[] {
    return calculateFlags(entry);
  }

  async getTimeEntry(userId: string, date: string): Promise<TimeEntry | null> {
    const entryId = `${userId}_${date}`;
    const snap = await getDoc(doc(db, 'timeEntries', entryId));
    if (!snap.exists()) return null;
    return mapEntry(snap.id, snap.data());
  }

  async getTimeEntriesForUser(userId: string): Promise<TimeEntry[]> {
    const q = query(
      collection(db, 'timeEntries'),
      where('userId', '==', userId),
      orderBy('workDate', 'desc')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => mapEntry(d.id, d.data()));
  }

  async getTimeEntriesForUserInRange(userId: string, startDate: string, endDate: string): Promise<TimeEntry[]> {
    const q = query(
      collection(db, 'timeEntries'),
      where('userId', '==', userId),
      where('workDate', '>=', startDate),
      where('workDate', '<=', endDate),
      orderBy('workDate', 'desc')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => mapEntry(d.id, d.data()));
  }

  async getAllTimeEntries(): Promise<TimeEntry[]> {
    const q = query(
      collection(db, 'timeEntries'),
      orderBy('workDate', 'desc'),
      limit(500)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => mapEntry(d.id, d.data()));
  }

  async getAllUsers(): Promise<User[]> {
    const snap = await getDocs(collection(db, 'users'));
    return snap.docs.map(d => {
      const data = d.data() as any;
      return {
        uid: d.id,
        email: String(data.email || ''),
        name: String(data.name || ''),
        role: String(data.role || 'employee').toLowerCase() as User['role'],
        active: data.active !== false,
      };
    });
  }

  async updateUser(uid: string, updates: Partial<User>): Promise<User> {
    await updateDoc(doc(db, 'users', uid), {
      ...updates,
      updatedAt: new Date(),
    } as any);
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) throw new Error('User not found');
    const data = snap.data() as any;
    return {
      uid: snap.id,
      email: String(data.email || ''),
      name: String(data.name || ''),
      role: String(data.role || 'employee').toLowerCase() as User['role'],
      active: data.active !== false,
    };
  }

  async deleteUserProfile(uid: string): Promise<void> {
    await deleteDoc(doc(db, 'users', uid));
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return null;
    const q = query(collection(db, 'users'), where('email', '==', normalizedEmail), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    const data = d.data() as any;
    return {
      uid: d.id,
      email: String(data.email || ''),
      name: String(data.name || ''),
      role: String(data.role || 'employee').toLowerCase() as User['role'],
      active: data.active !== false,
    };
  }

  async updateTimeEntry(id: string, updates: Partial<TimeEntry>): Promise<TimeEntry> {
    // Only supports a subset of fields used in admin corrections in this React UI.
    const patch: any = { updatedAt: Timestamp.now() };
    if (updates.clockInManual !== undefined) patch.clockInManual = updates.clockInManual;
    if (updates.lunchOutManual !== undefined) patch.lunchOutManual = updates.lunchOutManual;
    if (updates.lunchInManual !== undefined) patch.lunchInManual = updates.lunchInManual;
    if (updates.clockOutManual !== undefined) patch.clockOutManual = updates.clockOutManual;
    if (updates.skipLunch !== undefined) patch.lunchSkipped = updates.skipLunch;
    if (updates.adminNotes !== undefined) patch.correctionNotes = updates.adminNotes;
    if (updates.correctionRequested !== undefined) patch.correctionRequested = updates.correctionRequested;
    await updateDoc(doc(db, 'timeEntries', id), patch);
    const snap = await getDoc(doc(db, 'timeEntries', id));
    if (!snap.exists()) throw new Error('Entry not found');
    return mapEntry(snap.id, snap.data());
  }

  // ---- Correction Requests ----

  async createCorrectionRequest(data: Omit<CorrectionRequest, 'id'>): Promise<string> {
    const docRef = await addDoc(collection(db, 'correctionRequests'), {
      ...data,
      created_at: Timestamp.now(),
    });
    return docRef.id;
  }

  async getCorrectionRequestsForUser(userId: string): Promise<CorrectionRequest[]> {
    const q = query(
      collection(db, 'correctionRequests'),
      where('employee_id', '==', userId),
      orderBy('created_at', 'desc')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        employee_id: data.employee_id,
        employee_name: data.employee_name || '',
        requested_date: data.requested_date,
        issue_type: data.issue_type,
        notes: data.notes,
        suggested_time: data.suggested_time || undefined,
        original_clock_in: data.original_clock_in || undefined,
        original_clock_out: data.original_clock_out || undefined,
        original_lunch: data.original_lunch || undefined,
        requested_clock_in: data.requested_clock_in || undefined,
        requested_clock_out: data.requested_clock_out || undefined,
        requested_lunch: data.requested_lunch || undefined,
        status: data.status || 'Open',
        resolution_note: data.resolution_note || undefined,
        rejection_reason: data.rejection_reason || undefined,
        created_at: tsToMillis(data.created_at) || Date.now(),
        updated_at: tsToMillis(data.updated_at) || undefined,
        updated_by: data.updated_by || undefined,
      } as CorrectionRequest;
    });
  }

  async getAllCorrectionRequests(): Promise<CorrectionRequest[]> {
    const q = query(
      collection(db, 'correctionRequests'),
      orderBy('created_at', 'desc'),
      limit(500)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        employee_id: data.employee_id,
        employee_name: data.employee_name || '',
        requested_date: data.requested_date,
        issue_type: data.issue_type,
        notes: data.notes,
        suggested_time: data.suggested_time || undefined,
        original_clock_in: data.original_clock_in || undefined,
        original_clock_out: data.original_clock_out || undefined,
        original_lunch: data.original_lunch || undefined,
        requested_clock_in: data.requested_clock_in || undefined,
        requested_clock_out: data.requested_clock_out || undefined,
        requested_lunch: data.requested_lunch || undefined,
        status: data.status || 'Open',
        resolution_note: data.resolution_note || undefined,
        rejection_reason: data.rejection_reason || undefined,
        created_at: tsToMillis(data.created_at) || Date.now(),
        updated_at: tsToMillis(data.updated_at) || undefined,
        updated_by: data.updated_by || undefined,
      } as CorrectionRequest;
    });
  }

  async updateCorrectionRequest(id: string, updates: Partial<CorrectionRequest>): Promise<void> {
    const patch: any = { updated_at: Timestamp.now() };
    if (updates.status !== undefined) patch.status = updates.status;
    if (updates.resolution_note !== undefined) patch.resolution_note = updates.resolution_note;
    if (updates.rejection_reason !== undefined) patch.rejection_reason = updates.rejection_reason;
    if (updates.updated_by !== undefined) patch.updated_by = updates.updated_by;
    await updateDoc(doc(db, 'correctionRequests', id), patch);
  }

  async getPayrollSettings(): Promise<any> {
    const snap = await getDoc(doc(db, 'systemSettings', 'payroll'));
    if (snap.exists()) {
      return snap.data();
    }
    return null;
  }

  async setPayrollLock(dateStr: string, adminId: string): Promise<void> {
    await setDoc(doc(db, 'systemSettings', 'payroll'), {
      locked_up_to_date: dateStr,
      locked_at: Timestamp.now(),
      locked_by: adminId
    }, { merge: true });
  }
}

export const dbService = new DatabaseService();