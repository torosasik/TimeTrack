import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail as fbSendPasswordResetEmail, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';

export type UserRole = 'employee' | 'manager' | 'admin';
export type WorkModel = 'On-site' | 'Remote';

export interface WorkModelOverride {
  hasCustomRules: boolean;
  noOvertime?: boolean;
  overtimeLimit?: number;
  overtimeMultiplier?: number;
  doubleTimeLimit?: number;
  doubleTimeMultiplier?: number;
  weeklyOvertimeLimit?: number;
}

export interface User {
  uid: string;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
  work_email?: string;
  phone_number?: string;
  sms_opt_in?: boolean;
  timezone?: string;
  workModel: WorkModel;
  workModelId?: string;
  workModelOverride?: WorkModelOverride | null;
  /**
   * Pay-calculation anchor day for Remote employees, stored as a native
   * Firestore number. Written as 1 on user creation and backfilled to 1 on
   * every existing users doc by migrateRemotePayCalculationDay() (admin init).
   */
  remotePayCalculationDay?: number;
}

async function loadUserProfile(uid: string): Promise<User> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) {
    throw new Error('Account not initialized or access revoked');
  }
  const data = snap.data();
  return {
    uid,
    email: String(data.email || ''),
    name: String(data.name || ''),
    role: (String(data.role || 'employee').toLowerCase() as UserRole),
    active: data.active !== false,
    work_email: data.work_email,
    phone_number: data.phone_number,
    sms_opt_in: !!data.sms_opt_in,
    timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    workModel: data.workModel === 'Remote' ? 'Remote' : 'On-site',
    workModelId: data.workModelId as string | undefined,
    workModelOverride: (data.workModelOverride as WorkModelOverride | null | undefined) ?? null,
    remotePayCalculationDay: typeof data.remotePayCalculationDay === 'number' ? data.remotePayCalculationDay : undefined,
  };
}

class AuthService {
  async login(email: string, password: string): Promise<User> {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const profile = await loadUserProfile(cred.user.uid);
    if (!profile.active) {
      await signOut(auth);
      throw new Error('Account inactive');
    }
    return profile;
  }

  async register(name: string, email: string, password: string): Promise<User> {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;

    const newProfile = {
      uid,
      email,
      name,
      role: 'employee',
      active: true,
      createdAt: new Date(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sms_opt_in: false,
      workModel: 'On-site' as WorkModel,
      workModelOverride: null,
      remotePayCalculationDay: 1,
    };

    // Create the profile document in Firestore
    await setDoc(doc(db, 'users', uid), newProfile);

    return newProfile as User;
  }

  async loginWithGoogle(): Promise<User> {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    const uid = cred.user.uid;
    const email = cred.user.email || '';
    const name = cred.user.displayName || email.split('@')[0];

    try {
      // First try to load the profile if it exists
      const profile = await loadUserProfile(uid);
      if (!profile.active) {
        await signOut(auth);
        throw new Error('Account inactive');
      }
      return profile;
    } catch (err: unknown) {
      if ((err as Error).message === 'Account not initialized or access revoked') {
        // First time log in with google -> initialize profile
        const newProfile = {
          uid,
          email,
          name,
          role: 'employee',
          active: true,
          createdAt: new Date(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          sms_opt_in: false,
          workModel: 'On-site' as WorkModel,
          remotePayCalculationDay: 1,
        };

        // Create the profile document in Firestore
        await setDoc(doc(db, 'users', uid), newProfile);
        return newProfile as User;
      }
      throw err;
    }
  }

  async logout(): Promise<void> {
    await signOut(auth);
  }

  async sendPasswordResetEmail(email: string): Promise<void> {
    await fbSendPasswordResetEmail(auth, email);
  }

  onAuthStateChanged(callback: (user: User | null) => void): () => void {
    return onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) {
        callback(null);
        return;
      }

      try {
        const profile = await loadUserProfile(fbUser.uid);
        if (!profile.active) {
          await signOut(auth);
          callback(null);
          return;
        }
        callback(profile);
      } catch {
        await signOut(auth);
        callback(null);
      }
    });
  }
}

export const authService = new AuthService();
