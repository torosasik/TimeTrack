/**
 * Permission Helper Functions
 */

/**
 * Check if a user can edit a time entry
 * @param {string} userRole - Current user's role (admin, manager, employee)
 * @param {string} userId - Current user's ID
 * @param {string} entryUserId - Time entry owner's ID
 * @returns {boolean} True if user can edit the entry
 */
export function canEditEntry(userRole, userId, entryUserId) {
    // Employees cannot edit any entries
    if (userRole === 'employee') {
        return false;
    }

    // Managers can edit others only (not their own)
    if (userRole === 'manager') {
        return entryUserId !== userId;
    }

    // Admins can edit anyone (including themselves)
    if (userRole === 'admin') {
        return true;
    }

    return false;
}

/**
 * Check if user can create a time entry
 * @param {string} userRole - Current user's role
 * @returns {boolean} True if user can create entries
 */
export function canCreateEntry(userRole) {
    // Only employees can create entries
    return userRole === 'employee';
}

/**
 * Check if user can manage other users
 * @param {string} userRole - Current user's role
 * @returns {boolean} True if user can manage users
 */
export function canManageUsers(userRole) {
    // Only admins can manage users
    return userRole === 'admin';
}

/**
 * Check if user can view all time entries
 * @param {string} userRole - Current user's role
 * @returns {boolean} True if user can view all entries
 */
export function canViewAllEntries(userRole) {
    // Managers and admins can view all entries
    return userRole === 'manager' || userRole === 'admin';
}

/**
 * Get user's dashboard route based on role
 * @param {string} userRole - User's role
 * @returns {string} Dashboard path
 */
export function getDashboardRoute(userRole) {
    // React SPA: routing is handled client-side by role-aware views.
    // Keep this helper for compatibility with older code paths.
    return '/';
}
