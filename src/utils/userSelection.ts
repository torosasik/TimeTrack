import type { User } from '../app/lib/auth';

/**
 * Shared role-group selection model for user dropdowns across report / review /
 * audit views.
 *
 * Dropdowns render four bulk "group" options at the top (above a divider),
 * followed by the full per-user list (employees + managers + admins). A group
 * selection filters time-entry data to the users matching that role (or to all
 * users for "All").
 *
 * Sentinel values deliberately avoid collisions with real Firebase Auth UIDs,
 * which are 28-character alphanumeric strings.
 */

export const ALL_USERS = 'all';
export const ALL_EMPLOYEES = 'all_employees';
export const ALL_MANAGERS = 'all_managers';
export const ALL_ADMINS = 'all_admins';

export interface GroupOption {
  value: string;
  label: string;
}

/**
 * Ordered group options rendered at the top of every user dropdown, above the
 * `SelectSeparator`. "All" is first (broadest scope).
 */
export const USER_GROUP_OPTIONS: GroupOption[] = [
  { value: ALL_USERS, label: 'All' },
  { value: ALL_EMPLOYEES, label: 'All Employees' },
  { value: ALL_MANAGERS, label: 'All Managers' },
  { value: ALL_ADMINS, label: 'All Admins' },
];

/**
 * True when the dropdown value is a group sentinel (not a specific user uid).
 */
export function isGroupSelection(value: string): boolean {
  return (
    value === ALL_USERS ||
    value === ALL_EMPLOYEES ||
    value === ALL_MANAGERS ||
    value === ALL_ADMINS
  );
}

/**
 * Resolve a group selection into the concrete list of user IDs it represents.
 * For "All" this returns every known user id; for role-specific groups it
 * returns only the ids of users with that role. Callers should only invoke this
 * for group selections (use {@link isGroupSelection} to guard).
 */
export function resolveSelectedUserIds(value: string, allUsers: User[]): string[] {
  switch (value) {
    case ALL_EMPLOYEES:
      return allUsers.filter(u => u.role === 'employee').map(u => u.uid);
    case ALL_MANAGERS:
      return allUsers.filter(u => u.role === 'manager').map(u => u.uid);
    case ALL_ADMINS:
      return allUsers.filter(u => u.role === 'admin').map(u => u.uid);
    case ALL_USERS:
    default:
      return allUsers.map(u => u.uid);
  }
}

/**
 * Build a predicate over a time entry's `userId` that encodes the dropdown
 * selection. Used by client-side report filters to keep entries whose owner
 * matches the selected group (or single user).
 *
 * - "All" → passes every entry (no owner filtering), preserving the legacy
 *   behavior where 'all' returned the full collection (including entries owned
 *   by users no longer in `allUsers`).
 * - Role group → entry owner must be a known user of that role.
 * - Single uid → entry owner must equal that uid.
 */
export function buildUserIdMatcher(
  value: string,
  allUsers: User[],
): (userId: string) => boolean {
  if (value === ALL_USERS) return () => true;
  if (!isGroupSelection(value)) return (uid: string) => uid === value;
  const allowed = new Set(resolveSelectedUserIds(value, allUsers));
  return (uid: string) => allowed.has(uid);
}
