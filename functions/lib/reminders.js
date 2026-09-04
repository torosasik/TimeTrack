"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processReminders = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const notifications_1 = require("./notifications");
const moment_timezone_1 = __importDefault(require("moment-timezone"));
// Initialize admin if not already initialized in index.ts
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();
exports.processReminders = functions.pubsub.schedule('every 5 minutes').onRun(async (context) => {
    functions.logger.info("Starting reminder evaluations...");
    try {
        // 1. Fetch Global Settings (all system settings live in one doc).
        // Read-through fallback for the single-document migration: if
        // systemSettings/global doesn't exist yet (not migrated / no admin
        // save since deploy), fall back to the legacy systemSettings/reminders
        // doc so configured reminder preferences keep working instead of
        // silently reverting to hardcoded defaults.
        let settingsDoc = await db.collection('systemSettings').doc('global').get();
        if (!settingsDoc.exists) {
            functions.logger.warn("systemSettings/global missing — falling back to legacy systemSettings/reminders.");
            settingsDoc = await db.collection('systemSettings').doc('reminders').get();
        }
        if (!settingsDoc.exists) {
            functions.logger.warn("systemSettings/reminders also missing. Proceeding with defaults.");
        }
        const settings = settingsDoc.data() || {};
        const enableEmails = settings.enable_email_reminders !== false; // Default true
        const enableSMS = settings.enable_sms_reminders === true; // Default false
        const lunchReminderTimeStr = settings.lunch_reminder_time || '15:00';
        const clockOutReminderTimeStr = settings.clockout_reminder_time || '18:00';
        const longShiftThreshold = settings.longshift_threshold_hours || 10;
        // Output settings state cleanly.
        functions.logger.info(`Settings applied -> Emails: ${enableEmails}, SMS: ${enableSMS}`);
        // Break down strings into manipulatable arrays [H, M]
        const [lunchH, lunchM] = lunchReminderTimeStr.split(':').map(Number);
        const [clockOutH, clockOutM] = clockOutReminderTimeStr.split(':').map(Number);
        // 2. Fetch all Active Employees from Firestore
        const usersSnap = await db.collection('users').where('active', '==', true).get();
        // Use the current exact moment as the single truth tick for this function wrapper
        const nowUTC = moment_timezone_1.default.utc();
        for (const userDoc of usersSnap.docs) {
            const userData = userDoc.data();
            const uid = userDoc.id;
            // Ensure they have valid data to ping against
            const timezone = userData.timezone;
            if (!timezone) {
                // We log minimally to avoid spamming 5 min intervals for legacy unconfigured users
                continue;
            }
            const email = userData.work_email || userData.email;
            const phone = userData.phone_number;
            const smsOptIn = userData.sms_opt_in === true;
            const employeeLocalTime = nowUTC.clone().tz(timezone);
            const currentDateString = employeeLocalTime.format('YYYY-MM-DD'); // Based precisely on the employee's geography, NOT strict UTC date.
            // Fetch today's time entry
            // Using query exact matching the timezone-specific date string standard pattern
            const entryRef = db.collection('timeEntries').doc(`${uid}_${currentDateString}`);
            const entrySnap = await entryRef.get();
            if (!entrySnap.exists) {
                // They haven't clocked in today yet. Nothing to remind them about.
                continue;
            }
            const entry = entrySnap.data();
            if (entry.complete === true) {
                // Already fully closed out the day
                continue;
            }
            // Check current bounds
            const localHour = employeeLocalTime.hour();
            const localMinute = employeeLocalTime.minute();
            const isPastLunchThreshold = localHour > lunchH || (localHour === lunchH && localMinute >= lunchM);
            const isPastClockOutThreshold = localHour > clockOutH || (localHour === clockOutH && localMinute >= clockOutM);
            // We track if a save is needed to minimize write quota
            let updatesNeeded = {};
            // ---------------------------------------------------------
            // A) Lunch Reminder
            // ---------------------------------------------------------
            if (entry.clockInManual && // Clocked in
                !entry.lunchOutManual && // Has not clocked out for lunch
                !entry.skipLunch && // Has not skipped lunch explicitly
                !entry.clockOutManual && // Has not clocked out completely
                isPastLunchThreshold && // Passed the admin-defined check time locally
                !entry.lunch_reminder_sent_at // Has never been sent this specific reminder today
            ) {
                functions.logger.info(`Triggering Lunch Reminder for UID: ${uid}`);
                if (enableEmails && email) {
                    const body = `You have not logged your lunch break today.\nIf you already took lunch, please log Lunch Out and Lunch In.\nIf approved to skip lunch, select "Skip Lunch Break" in the app.`;
                    await notifications_1.notificationService.sendEmail(email, 'Reminder: Lunch break not logged', body);
                }
                if (enableSMS && smsOptIn && phone) {
                    await notifications_1.notificationService.sendSMS(phone, `Reminder: lunch break not logged today. Please update your time in the app.`);
                }
                // Must write exactly ONCE, regardless of actual SMS/Email delivery success to prevent spamloops on transient API errors.
                updatesNeeded.lunch_reminder_sent_at = admin.firestore.FieldValue.serverTimestamp();
            }
            // ---------------------------------------------------------
            // B) Clock Out Reminder
            // ---------------------------------------------------------
            if (entry.clockInManual && // Clocked in
                !entry.clockOutManual && // Has not clocked out completely
                isPastClockOutThreshold && // Passed the admin-defined check time locally
                !entry.clockout_reminder_sent_at // Never been warned today
            ) {
                functions.logger.info(`Triggering Clock Out Reminder for UID: ${uid}`);
                if (enableEmails && email) {
                    const body = `You have not clocked out today.\nIf your shift ended, please log your Clock Out time.`;
                    await notifications_1.notificationService.sendEmail(email, 'Reminder: You are still clocked in', body);
                }
                if (enableSMS && smsOptIn && phone) {
                    await notifications_1.notificationService.sendSMS(phone, `Reminder: you have not clocked out today. Please update your time in the app.`);
                }
                updatesNeeded.clockout_reminder_sent_at = admin.firestore.FieldValue.serverTimestamp();
            }
            // ---------------------------------------------------------
            // C) Long Shift Reminder (10+ hours defaults)
            // ---------------------------------------------------------
            if (entry.clockInManual &&
                !entry.clockOutManual &&
                !entry.longshift_reminder_sent_at) {
                // Parse raw time entry against precisely today's local date
                const clockInMoment = moment_timezone_1.default.tz(`${currentDateString} ${entry.clockInManual}`, "YYYY-MM-DD HH:mm", timezone);
                const hoursElapsed = employeeLocalTime.diff(clockInMoment, 'hours', true);
                if (hoursElapsed >= longShiftThreshold) {
                    functions.logger.info(`Triggering Long Shift Warning (${hoursElapsed.toFixed(2)}h) for UID: ${uid}`);
                    if (enableEmails && email) {
                        const body = `You have been clocked in for over ${longShiftThreshold} hours.\nIf you forgot to clock out, please update your time.`;
                        await notifications_1.notificationService.sendEmail(email, 'Reminder: Long shift detected', body);
                    }
                    if (enableSMS && smsOptIn && phone) {
                        await notifications_1.notificationService.sendSMS(phone, `You have been clocked in over ${longShiftThreshold} hours. Please confirm or clock out.`);
                    }
                    updatesNeeded.longshift_reminder_sent_at = admin.firestore.FieldValue.serverTimestamp();
                }
            }
            // ---------------------------------------------------------
            // Commit the changes to effectively block all future reminders natively
            // ---------------------------------------------------------
            if (Object.keys(updatesNeeded).length > 0) {
                await entryRef.update(updatesNeeded);
                functions.logger.info(`Updated reminder trackers for UID: ${uid}`);
            }
        } // end user iteration
    }
    catch (error) {
        functions.logger.error("Error in processReminders cron job:", error);
    }
    return null;
});
//# sourceMappingURL=reminders.js.map