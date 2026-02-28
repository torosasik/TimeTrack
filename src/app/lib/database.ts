import { collection, doc, getDoc, getDocs, orderBy, query, Timestamp, updateDoc, where, limit, deleteDoc } from 'firebase/firestore';
import { db } from './firebase';
import type { User } from './auth';

export interface TimeEntry {
  id: string;               // Firestore doc id (uid_date)
  userId: string;
  date: string;             // YYYY-MM-DD

  clockInManual?: string;
  clockInSystem?: number;   // millis
  lunchOutManual?: string;
  lunchOutSystem?: number;  // millis
  lunchInManual?: string;
  lunchInSystem?: number;   // millis
  clockOutManual?: string;
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

  completedAt?: number;     // millis
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
    completedAt: tsToMillis(data.completedAt),
  };

  // Flags are not stored in Firestore by default; compute basic flags for UI
  entry.flags = calculateFlags(entry);
  return entry;
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
    await updateDoc(doc(db, 'timeEntries', id), patch);
    const snap = await getDoc(doc(db, 'timeEntries', id));
    if (!snap.exists()) throw new Error('Entry not found');
    return mapEntry(snap.id, snap.data());
  }
}

export const dbService = new DatabaseService();