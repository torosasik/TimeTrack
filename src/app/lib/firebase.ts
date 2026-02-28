import { initializeApp, getApps } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

// Reuse the existing config (keeps the same Firebase project)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - JS module
import { firebaseConfig } from '../../config/firebase.config.js';

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// Local-only emulator wiring (opt-in)
declare global {
  // eslint-disable-next-line no-var
  var __TT_EMULATORS_CONNECTED__: boolean | undefined;
}

const useEmulators =
  import.meta.env.VITE_USE_EMULATORS === 'true' ||
  (import.meta.env.DEV && new URLSearchParams(window.location.search).has('emu'));

if (useEmulators && !globalThis.__TT_EMULATORS_CONNECTED__) {
  // Auth emulator
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  // Firestore emulator
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  globalThis.__TT_EMULATORS_CONNECTED__ = true;
}

