/**
 * One-time backfill: ensure every users/{uid} document physically contains
 * `remotePayCalculationDay: 1` as a native Firestore number.
 *
 * Triggered once on admin init (AdminPanel mount). Only admins may run it:
 * firestore.rules gates `users` updates to `hasRole('admin')` or a narrow
 * self-service key set that does not include this field.
 *
 * Idempotent by construction: docs that already hold a numeric
 * `remotePayCalculationDay` are skipped, so repeat runs are read-only no-ops.
 * Docs holding a non-numeric value are rewritten so the console always shows
 * a number (satisfies the Stage-1 verification criterion).
 */
import { collection, doc, getDocs, updateDoc } from 'firebase/firestore';
import { db } from '../app/lib/firebase';

export const DEFAULT_REMOTE_PAY_CALCULATION_DAY = 1;

export interface RemotePayCalculationDayMigrationResult {
  scanned: number;
  updated: number;
  updatedUids: string[];
}

export async function migrateRemotePayCalculationDay(): Promise<RemotePayCalculationDayMigrationResult> {
  const snap = await getDocs(collection(db, 'users'));

  const missing = snap.docs.filter(d => typeof d.data().remotePayCalculationDay !== 'number');

  await Promise.all(
    missing.map(d =>
      updateDoc(doc(db, 'users', d.id), {
        remotePayCalculationDay: DEFAULT_REMOTE_PAY_CALCULATION_DAY,
      }),
    ),
  );

  return {
    scanned: snap.size,
    updated: missing.length,
    updatedUids: missing.map(d => d.id),
  };
}
