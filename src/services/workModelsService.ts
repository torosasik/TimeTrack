import { collection, doc, getDocs, addDoc, updateDoc } from 'firebase/firestore';
import { db } from '../app/lib/firebase';

export interface WorkModel {
  id: string;
  name: string;
  noOvertime: boolean;
  overtimeLimit: number;
  overtimeMultiplier: number;
  doubleTimeLimit: number;
  doubleTimeMultiplier: number;
  weeklyOvertimeLimit: number;
  status?: 'active' | 'voided';
}

export interface WorkModelInput {
  name: string;
  noOvertime: boolean;
  overtimeLimit: number;
  overtimeMultiplier: number;
  doubleTimeLimit: number;
  doubleTimeMultiplier: number;
  weeklyOvertimeLimit: number;
}

const DEFAULT_MODELS: WorkModelInput[] = [
  {
    name: 'On-site',
    noOvertime: false,
    overtimeLimit: 8,
    overtimeMultiplier: 1.5,
    doubleTimeLimit: 12,
    doubleTimeMultiplier: 2.0,
    weeklyOvertimeLimit: 40,
  },
  {
    name: 'Remote',
    noOvertime: true,
    overtimeLimit: 8,
    overtimeMultiplier: 1.5,
    doubleTimeLimit: 12,
    doubleTimeMultiplier: 2.0,
    weeklyOvertimeLimit: 40,
  },
];

function mapDoc(id: string, data: Record<string, unknown>): WorkModel {
  return {
    id,
    name: String(data.name ?? ''),
    noOvertime: data.noOvertime === true,
    overtimeLimit: Number(data.overtimeLimit ?? 8),
    overtimeMultiplier: Number(data.overtimeMultiplier ?? 1.5),
    doubleTimeLimit: Number(data.doubleTimeLimit ?? 12),
    doubleTimeMultiplier: Number(data.doubleTimeMultiplier ?? 2.0),
    weeklyOvertimeLimit: Number(data.weeklyOvertimeLimit ?? 40),
    status: data.status === 'voided' ? 'voided' : 'active',
  };
}

/**
 * Read all non-voided work models, surfaced to the Settings UI / pill resolver /
 * dropdown.
 *
 * IMPORTANT: this queries the collection WITHOUT a Firestore `status != 'voided'`
 * inequality filter and instead filters client-side. Firestore inequality
 * queries silently EXCLUDE documents that lack the filtered field entirely, so
 * the old `where('status', '!=', 'voided')` made legacy workModel docs (created
 * before the `status` field existed) invisible to both this list AND to
 * `ensureSeeded`'s emptiness check — which caused `ensureSeeded` to think the
 * collection was empty and double-seed the defaults (4 docs: 2 active + 2
 * orphaned status-less). Querying directly and filtering `status !== 'voided'`
 * in JS recognizes active AND status-less docs, so the legacy orphans become
 * visible/manageable and re-seeding no longer fires while they exist.
 */
async function fetchActiveWorkModels(): Promise<WorkModel[]> {
  const snap = await getDocs(collection(db, 'workModels'));
  return snap.docs
    .filter(d => d.get('status') !== 'voided')
    .map(d => mapDoc(d.id, d.data()));
}

export async function listWorkModels(): Promise<WorkModel[]> {
  // Voided docs remain in the collection for referential integrity (users may
  // still reference a voided model via workModelId; the UI falls back gracefully).
  const models = await fetchActiveWorkModels();
  if (models.length === 0) {
    await ensureSeeded();
    return fetchActiveWorkModels();
  }
  return models;
}

/**
 * Read ALL work models INCLUDING soft-deleted (status: 'voided') ones.
 *
 * For referential-integrity lookups ONLY — e.g. classifying a user whose
 * workModelId still points at a voided model. resolveWorkModelName /
 * isRemoteWorkModel fall back to the drift-prone legacy workModel string when
 * the FK doesn't resolve against the list, so a user assigned to a voided
 * Remote-named model would otherwise be silently misclassified as On-site.
 * UI lists and dropdowns must keep using listWorkModels() (active only) —
 * this intentionally has no ensureSeeded side effect.
 */
export async function listAllWorkModels(): Promise<WorkModel[]> {
  const snap = await getDocs(collection(db, 'workModels'));
  return snap.docs.map(d => mapDoc(d.id, d.data()));
}

export async function ensureSeeded(): Promise<void> {
  // Seed only if there are zero usable (non-voided) models — including legacy
  // status-less docs, which count as usable so we never re-seed over them.
  // See fetchActiveWorkModels for why we avoid the status inequality filter.
  // A collection of only-voided docs (everything deleted) still re-seeds the
  // defaults so the app isn't left with zero usable models.
  const models = await fetchActiveWorkModels();
  if (models.length > 0) return;
  for (const model of DEFAULT_MODELS) {
    await addDoc(collection(db, 'workModels'), { ...model, status: 'active' });
  }
}

export async function createWorkModel(input: WorkModelInput): Promise<WorkModel> {
  const ref = await addDoc(collection(db, 'workModels'), { ...input, status: 'active' });
  return { id: ref.id, ...input, status: 'active' };
}

export async function updateWorkModel(id: string, input: WorkModelInput): Promise<WorkModel> {
  // Re-assert status: 'active' on write so the persisted doc matches the
  // returned object. This also gives "edit restores an active model" semantics
  // for any direct API caller (the UI only edits already-active models since
  // voided ones are excluded from the list).
  await updateDoc(doc(db, 'workModels', id), { ...input, status: 'active' });
  return { id, ...input, status: 'active' };
}

export async function deleteWorkModel(id: string): Promise<void> {
  // Soft delete only — never hard-delete. Sets status to 'voided' so the doc
  // remains resolvable for any user whose workModelId still points at it,
  // but is excluded from active model lists. (AGENTS.md soft-delete rule +
  // referential integrity for users.workModelId.)
  await updateDoc(doc(db, 'workModels', id), { status: 'voided' });
}
