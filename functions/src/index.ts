import * as admin from 'firebase-admin';

// Initialize Firebase Admin globally once
if (!admin.apps.length) {
    admin.initializeApp();
}

export * from './reminders';
export * from './autoGuardrails';
// NOTE: `repairRunawayShifts` is intentionally NOT a deployed function. v1
// callable deploys require granting roles/cloudfunctions.invoker to allUsers,
// which the org policy blocks. The repair now runs as a client-side admin
// utility (src/services/repairRunawayShifts.ts) via the Admin Panel.
// We export the entire file so Cloud Functions router picks up `processReminders`
