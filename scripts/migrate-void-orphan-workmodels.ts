/**
 * One-time migration: void orphaned workModel docs that lack a `status` field.
 *
 * Background: legacy workModel docs created before the `status` field was
 * introduced were invisible to Firestore's `status != 'voided'` inequality
 * query (the field doesn't exist, so the doc is excluded). This made them
 * invisible to listWorkModels AND made ensureSeeded think the collection was
 * empty, causing duplicate re-seeding (4 docs: 2 active + 2 orphans).
 *
 * After the workModelsService.ts fix, these orphans are now VISIBLE in the
 * Work Model Settings UI and can simply be deleted there (the UI's delete
 * button soft-voids them). This script is an OPTIONAL alternative for those
 * who prefer CLI cleanup. It authenticates as an admin user (firestore.rules
 * restricts workModel writes to admins) and soft-voids (never hard-deletes,
 * per AGENTS.md) any doc lacking a `status` field.
 *
 * Usage:
 *   TT_ADMIN_PASS='<password>' npx tsx scripts/migrate-void-orphan-workmodels.ts
 *   # optionally: TT_ADMIN_EMAIL='other@admin.com' ...
 *
 * Idempotent: re-running re-voids nothing (status-less docs become voided;
 * already-voided/active docs are untouched).
 */
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, doc, getDocs, query, updateDoc } from 'firebase/firestore';

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
    console.log('Authenticated. Reading workModels collection...');

    const snap = await getDocs(query(collection(db, 'workModels')));
    console.log(`Found ${snap.size} total workModel doc(s).`);

    let voided = 0;
    let skippedActive = 0;
    let skippedVoided = 0;

    for (const d of snap.docs) {
        const data = d.data();
        if (data.status === 'voided') {
            skippedVoided++;
            continue;
        }
        if (data.status === 'active') {
            skippedActive++;
            continue;
        }
        // Orphan: no `status` field (or an unrecognized value). Void it so it
        // is excluded from active lists and no longer triggers re-seeding.
        await updateDoc(doc(db, 'workModels', d.id), {
            status: 'voided',
            voidedAt: Date.now(),
            voidedBy: 'migration:orphan-status-less',
            voidedReason: 'Legacy doc lacking status field; voided during orphan cleanup.',
        });
        console.log(`  voided orphan ${d.id} (name=${data.name ?? '<unset>'})`);
        voided++;
    }

    console.log('---');
    console.log(`Voided orphans: ${voided}`);
    console.log(`Skipped (already active): ${skippedActive}`);
    console.log(`Skipped (already voided): ${skippedVoided}`);
}

migrate().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
