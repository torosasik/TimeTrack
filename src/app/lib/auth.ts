import { onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail as fbSendPasswordResetEmail } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './firebase';

export type UserRole = 'employee' | 'manager' | 'admin';

export interface User {
  uid: string;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
}

async function loadUserProfile(uid: string): Promise<User> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) {
    throw new Error('Account not initialized or access revoked');
  }
  const data = snap.data() as any;
  return {
    uid,
    email: String(data.email || ''),
    name: String(data.name || ''),
    role: (String(data.role || 'employee').toLowerCase() as UserRole),
    active: data.active !== false,
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
      } catch (e) {
        await signOut(auth);
        callback(null);
      }
    });
  }
}

export const authService = new AuthService();
