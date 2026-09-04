/**
 * Shared work-model resolution.
 *
 * A user has two parallel work-model fields: the newer `workModelId` FK into
 * the workModels collection (authoritative) and the legacy `workModel` string
 * ('On-site' / 'Remote'). They can drift when a write path updates only one.
 * Every read site that needs to know whether a user is Remote-type MUST go
 * through these helpers instead of reading `user.workModel` directly, so the
 * answer is always derived from the same precedence the table pill and header
 * filter use (see resolveWorkModelLabel in AdminPanel).
 *
 * Precedence: `workModelId` lookup wins; falls back to the legacy string; then
 * the caller's fallback.
 */
import type { User } from '../app/lib/auth';
import type { WorkModel } from '../services/workModelsService';

/**
 * The user's effective work-model display name. `workModelId` → model name
 * when the FK resolves against the provided list; otherwise the legacy string.
 */
export function resolveWorkModelName(
  user: Pick<User, 'workModel' | 'workModelId'>,
  workModels: WorkModel[],
): string {
  const byId = user.workModelId ? workModels.find(m => m.id === user.workModelId) : undefined;
  return byId?.name || user.workModel || '';
}

/**
 * True when the user's effective work model is Remote-type. A model counts as
 * Remote when its resolved name contains "remote" (case-insensitive) — this
 * covers the canonical 'Remote' model and any custom Remote-flavored model
 * (e.g. "Remote East"), matching the classification the write paths use when
 * deriving the legacy string from a chosen model.
 */
export function isRemoteWorkModel(
  user: Pick<User, 'workModel' | 'workModelId'>,
  workModels: WorkModel[],
): boolean {
  return resolveWorkModelName(user, workModels).toLowerCase().includes('remote');
}
