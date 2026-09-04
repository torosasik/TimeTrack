import { initializeApp, getApps } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';

// Reuse the existing config (keeps the same Firebase project)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - JS module
import { firebaseConfig } from '../../config/firebase.config.js';

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Local-only emulator wiring (opt-in)
declare global {
  var __TT_EMULATORS_CONNECTED__: boolean | undefined;
}

const useEmulators =
  import.meta.env.VITE_USE_EMULATORS === 'true' ||
  (import.meta.env.DEV && new URLSearchParams(window.location.search).has('emu'));

// Layer 2 fix: enable Firestore offline persistence so punch writes that fail
// on a flaky connection are buffered in IndexedDB and replayed automatically
// when connectivity returns. Without this, a lost clock-out packet (the root
// cause of the employee's stuck "open shift" days on 06-15/06-24/06-25/07-10)
// silently dropped the action — the user saw no durable error and never
// re-tapped.
//
// `initializeFirestore` must be called BEFORE getFirestore on the app instance
// and only once per app (it throws if firestore is already initialized — e.g.
// under Vite HMR — which we catch and fall back to the existing handle). The
// cache type is fixed at init time and cannot be changed later.
//
// Emulator mode skips persistence: the emulator is single-process and
// persistentLocalCache would shadow emulator data with stale local cache,
// breaking rule tests and hiding real doc state.
let db;
if (useEmulators) {
  db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
} else {
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch {
    // Already initialized (HMR / multi-import) — reuse the existing handle.
    db = getFirestore(app);
  }
}
export { db };

if (useEmulators && !globalThis.__TT_EMULATORS_CONNECTED__) {
  // Auth emulator
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  globalThis.__TT_EMULATORS_CONNECTED__ = true;
}

