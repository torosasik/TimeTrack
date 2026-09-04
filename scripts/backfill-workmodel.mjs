/**
 * One-time backfill: set `workModel: 'On-site'` on every Firestore user
 * document that is missing the field (legacy docs created before the
 * `workModel` attribute was introduced).
 *
 * The read/mapper layer already defaults a missing `workModel` to 'On-site'
 * in memory (see src/app/lib/auth.ts `loadUserProfile` and the three mapping
 * sites in src/app/lib/database.ts). This script materializes that default
 * in storage so legacy docs match new ones.
 *
 * Idempotent: documents already carrying a valid `workModel`
 * ('On-site' | 'Remote') are left untouched.
 *
 * Uses the Firebase Admin SDK, which bypasses firestore.rules (the
 * `users/{userId}` update rule is admin-only at firestore.rules:44), so it can
 * touch every user doc regardless of role.
 *
 * Modes:
 *   - Emulator:  set FIRESTORE_EMULATOR_HOST (e.g. localhost:8080) — no
 *                service account required.
 *   - Live:      set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON
 *                (matches scripts/seed-live-test-profiles.mjs).
 *
 * Flags:
 *   --dry-run    Report what would be updated without writing.
 *
 * Run:
 *   node scripts/backfill-workmodel.mjs --dry-run
 *   node scripts/backfill-workmodel.mjs
 */
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import admin from 'firebase-admin';

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'atd-time-tracking';
const BATCH_LIMIT = 500;
const VALID_WORK_MODELS = new Set(['On-site', 'Remote']);
const DEFAULT_WORK_MODEL = 'On-site';

/**
 * Pure backfill core. Takes an admin-like Firestore `db` handle
 * (collection().get() -> { docs: [{ data(), ref }] }, batch().update(ref,patch),
 * batch().commit()) and returns { scanned, alreadyValid, updated }.
 *
 * Exported so the logic can be exercised against a mock without a real
 * Firestore (see scripts/_verify-backfill.mjs).
 */
export async function runBackfill(db, { dryRun = false, log = (m) => console.log(m), batchSize = BATCH_LIMIT } = {}) {
  const snap = await db.collection('users').get();

  const toUpdate = [];
  let alreadyValid = 0;
  for (const d of snap.docs) {
    const data = d.data() || {};
    if (VALID_WORK_MODELS.has(data.workModel)) {
      alreadyValid++;
      continue;
    }
    toUpdate.push(d.ref);
  }

  log(`[backfill] scanned: ${snap.size} user document(s)`);
  log(`[backfill] already valid (skipped): ${alreadyValid}`);
  log(`[backfill] missing workModel (to update): ${toUpdate.length}`);

  if (dryRun) {
    log('[backfill] DRY RUN — no writes performed.');
    return { scanned: snap.size, alreadyValid, updated: 0, toUpdate: toUpdate.length };
  }

  if (toUpdate.length === 0) {
    log('[backfill] nothing to update.');
    return { scanned: snap.size, alreadyValid, updated: 0, toUpdate: 0 };
  }

  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += batchSize) {
    const chunk = toUpdate.slice(i, i + batchSize);
    const batch = db.batch();
    for (const ref of chunk) {
      batch.update(ref, { workModel: DEFAULT_WORK_MODEL });
    }
    await batch.commit();
    updated += chunk.length;
    log(`[backfill] committed batch: +${chunk.length} (running total ${updated}/${toUpdate.length})`);
  }

  log(`[backfill] DONE. Updated ${updated} document(s).`);
  return { scanned: snap.size, alreadyValid, updated, toUpdate: toUpdate.length };
}

function initApp() {
  if (admin.apps.length) return admin.apps[0];
  const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  if (emulator) {
    // Emulator: Admin SDK routes Firestore to FIRESTORE_EMULATOR_HOST and does
    // not require a real credential.
    return admin.initializeApp({ projectId: PROJECT_ID });
  }
  const KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!KEY_PATH) {
    console.error(
      'Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json, or run against the emulator (set FIRESTORE_EMULATOR_HOST).'
    );
    process.exit(1);
  }
  const serviceAccount = JSON.parse(readFileSync(resolve(KEY_PATH), 'utf8'));
  return admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: PROJECT_ID });
}

async function main() {
  const app = initApp();
  const db = admin.firestore(app);

  const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  const dryRun = process.argv.includes('--dry-run');
  const target = emulator ? `emulator (${process.env.FIRESTORE_EMULATOR_HOST})` : `live (${PROJECT_ID})`;
  console.log(`[backfill] target: ${target}`);
  console.log(`[backfill] mode: ${dryRun ? 'DRY RUN (no writes)' : 'WRITE'}`);

  await runBackfill(db, { dryRun });
}

// CLI entry — only runs when invoked directly, not when imported.
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[backfill] FAILED:', err?.message || err);
      process.exit(1);
    });
}
