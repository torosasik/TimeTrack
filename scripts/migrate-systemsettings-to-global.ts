/**
 * One-time migration: copy legacy split settings docs into the consolidated
 * `systemSettings/global` document.
 *
 * Background: system settings were previously stored across two docs —
 * `systemSettings/reminders` (5 reminder fields) and `systemSettings/payroll`
 * (4 payroll fields + audit metadata). The codebase now reads/writes a single
 * `systemSettings/global` doc. A read-through fallback in
 * `fetchGlobalSettings()` / `processReminders` keeps things working while
 * `global` is absent, but this migration performs the clean cutover so the
 * legacy docs can be retired.
 *
 * Behavior:
 *   - Reads `systemSettings/reminders` + `systemSettings/payroll` and merges
 *     their fields into `systemSettings/global` (merge: true, so any already-
 *     saved global values are preserved).
 *   - If `global` already exists, the merge still copies any legacy fields that
 *     are absent from global (safe idempotent re-run).
 *   - Does NOT delete the legacy docs (soft approach — leave them in place as
 *     a rollback safety net; they can be voided/archived manually later).
 *
 * Usage:
 *   TT_ADMIN_PASS='<password>' npx tsx scripts/migrate-systemsettings-to-global.ts
 *   # optionally: TT_ADMIN_EMAIL='other@admin.com' ...
 *
 * Authenticates as an admin user (firestore.rules restrict systemSettings
 * writes to admins).
 */
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyC_6fkVeub7ZJp4yzSAIp6yZEsrhRk5lQI",
    authDomain: "atd-time-tracking.firebaseapp.com",
    projectId: "atd-time-tracking",
    storageBucket: "atd-time-tracking.firebasestorage.app",
    messagingSenderId: "115771623376",
    appId: "1:115771623376:web:214008a8dfa2007f731bd5"
};

const ADMIN_EMAIL = process.env.TT_ADMIN_EMAIL || 'korkutunal@americantiledepot.com';
const ADMIN_PASS = process.env.TT_ADMIN_PASS;

if (!ADMIN_PASS) {
    console.error('Set TT_ADMIN_PASS env var to the admin account password before running.');
    process.exit(1);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

async function migrate() {
    console.log(`Authenticating as ${ADMIN_EMAIL}...`);
    try {
        await signInWithEmailAndPassword(auth, ADMIN_EMAIL, ADMIN_PASS);
    } catch (err) {
        console.error('Authentication failed:', err);
        process.exit(1);
    }

    const remindersSnap = await getDoc(doc(db, 'systemSettings', 'reminders'));
    const payrollSnap = await getDoc(doc(db, 'systemSettings', 'payroll'));
    const globalSnap = await getDoc(doc(db, 'systemSettings', 'global'));

    const remindersData = remindersSnap.exists() ? remindersSnap.data() : {};
    const payrollData = payrollSnap.exists() ? payrollSnap.data() : {};

    const hasLegacy = remindersSnap.exists() || payrollSnap.exists();
    if (!hasLegacy && !globalSnap.exists()) {
        console.log('No settings docs exist anywhere. Nothing to migrate.');
        return;
    }

    // Merge: existing global fields win (so an admin's post-deploy save isn't
    // clobbered), then fill in any missing fields from the legacy docs.
    const merged: Record<string, unknown> = {
        ...remindersData,
        ...payrollData,
        ...(globalSnap.exists() ? globalSnap.data() : {}),
    };

    await setDoc(doc(db, 'systemSettings', 'global'), merged, { merge: true });

    console.log('---');
    console.log('Merged fields into systemSettings/global:');
    console.log(`  from reminders: ${remindersSnap.exists() ? Object.keys(remindersData).length + ' fields' : '(absent)'}`);
    console.log(`  from payroll:   ${payrollSnap.exists() ? Object.keys(payrollData).length + ' fields' : '(absent)'}`);
    console.log(`  global existed: ${globalSnap.exists() ? 'yes (merged onto it)' : 'no (created)'}`);
    console.log(`  total fields written: ${Object.keys(merged).length}`);
    console.log('');
    console.log('Legacy reminders/payroll docs were LEFT IN PLACE as a rollback safety net.');
}

migrate().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
