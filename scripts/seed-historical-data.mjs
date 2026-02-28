import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

const PROJECT_ID = 'atd-time-tracking';
const FIRESTORE_RULES_PATH = path.resolve(process.cwd(), 'firestore.rules');

// This script assumes `scripts/seed-test-users.mjs` has already been run
// and `employee@test.local` exists. We will fetch its UID from the Emulator Auth
// or hardcode the known test UID if possible, but let's try to fetch or assume a hardcoded one for simplicity if allowed?
// Actually, `seed-test-users.mjs` prints the UIDs but doesn't save them.
// To keep it simple, I'll fetch the user via the specialized Auth REST API again or just
// use the same helper `ensureAuthUser` which returns the existing UID.

const EMULATOR_AUTH = 'http://127.0.0.1:9099';
const TEST_EMPLOYEE_EMAIL = 'employee@test.local';
const TEST_EMPLOYEE_PASSWORD = 'Test123!';

async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        json = { raw: text };
    }
    if (!res.ok) {
        // Ignore EMAIL_EXISTS error if we just want to look it up, handled by caller or here
        if (res.status === 400 && json?.error?.message === 'EMAIL_EXISTS') {
            throw new Error('EMAIL_EXISTS');
        }
        throw new Error(json?.error?.message || res.statusText);
    }
    return json;
}

async function getEmployeeUid() {
    const signInUrl = `${EMULATOR_AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`;
    try {
        const signedIn = await postJson(signInUrl, {
            email: TEST_EMPLOYEE_EMAIL,
            password: TEST_EMPLOYEE_PASSWORD,
            returnSecureToken: true
        });
        return signedIn.localId;
    } catch (e) {
        console.error(`Failed to sign in as ${TEST_EMPLOYEE_EMAIL}:`, e.message);
        throw e;
    }
}

// Helper to generate time entries
function createTimeEntry(uid, dateStr, type) {
    // dateStr is YYYY-MM-DD
    const id = `${uid}_${dateStr}`;
    const baseDate = new Date(dateStr + 'T00:00:00');

    let entry = {
        id,
        userId: uid,
        date: dateStr,
        workDate: dateStr, // Used for querying
        clockInSystem: baseDate.setHours(9, 0, 0, 0),
        clockInManual: '09:00',
        clockOutSystem: baseDate.setHours(17, 30, 0, 0),
        clockOutManual: '17:30',
        lunchOutSystem: baseDate.setHours(12, 0, 0, 0),
        lunchOutManual: '12:00',
        lunchInSystem: baseDate.setHours(12, 30, 0, 0),
        lunchInManual: '12:30',
        skipLunch: false,
        complete: true,
        dayComplete: true, // Legacy field
        completedAt: baseDate.setHours(17, 30, 0, 0),
        totalHours: 8.0,
        history: [],
        flags: [] // For audit
    };

    if (type === 'overtime') {
        // 9am to 9pm (12 hours) - 30m lunch = 11.5 hours
        entry.clockOutManual = '21:00';
        entry.clockOutSystem = baseDate.setHours(21, 0, 0, 0);
        entry.completedAt = entry.clockOutSystem;
        entry.totalHours = 11.5;
    } else if (type === 'double_time') {
        // 9am to 11pm (14 hours) - 30m lunch = 13.5 hours
        entry.clockOutManual = '23:00';
        entry.clockOutSystem = baseDate.setHours(23, 0, 0, 0);
        entry.completedAt = entry.clockOutSystem;
        entry.totalHours = 13.5;
    } else if (type === 'incomplete') {
        entry.clockOutManual = undefined;
        entry.clockOutSystem = undefined;
        entry.completedAt = undefined;
        entry.complete = false;
        entry.dayComplete = false;
        entry.totalHours = 0;
    } else if (type === 'late_submission') {
        // Clock in at 9:00, but submitted at 10:00 (1 hour gap)
        entry.clockInSystem = baseDate.setHours(10, 0, 0, 0);
        // This will trigger 'late_submission' flag in AuditViewer
    } else if (type === 'batch_submission') {
        // All timestamps close together
        const now = Date.now();
        entry.clockInSystem = now;
        entry.lunchOutSystem = now + 1000;
        entry.lunchInSystem = now + 2000;
        entry.clockOutSystem = now + 3000;
        entry.completedAt = now + 3000;
        // This will trigger 'batch_submission' flag
    }

    return entry;
}

async function main() {
    console.log('[seed-history] Starting...');

    const rules = fs.readFileSync(FIRESTORE_RULES_PATH, 'utf8');
    const testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: { host: '127.0.0.1', port: 8080, rules }
    });

    try {
        const uid = await getEmployeeUid();
        console.log(`[seed-history] Seeding data for ${TEST_EMPLOYEE_EMAIL} (${uid})...`);

        // Generate dates relative to today
        const today = new Date();
        const formatDate = (d) => d.toISOString().split('T')[0];

        const entries = [];

        // 1. Regular day (Yesterday)
        const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
        entries.push(createTimeEntry(uid, formatDate(yesterday), 'regular'));

        // 2. Overtime day (2 days ago)
        const d2 = new Date(today); d2.setDate(today.getDate() - 2);
        entries.push(createTimeEntry(uid, formatDate(d2), 'overtime'));

        // 3. Double time day (3 days ago)
        const d3 = new Date(today); d3.setDate(today.getDate() - 3);
        entries.push(createTimeEntry(uid, formatDate(d3), 'double_time'));

        // 4. Incomplete day (Today) - assuming they clocked in
        entries.push(createTimeEntry(uid, formatDate(today), 'incomplete'));

        // 5. Late submission (4 days ago)
        const d4 = new Date(today); d4.setDate(today.getDate() - 4);
        entries.push(createTimeEntry(uid, formatDate(d4), 'late_submission'));

        // 6. Batch submission (5 days ago)
        const d5 = new Date(today); d5.setDate(today.getDate() - 5);
        entries.push(createTimeEntry(uid, formatDate(d5), 'batch_submission'));

        await testEnv.withSecurityRulesDisabled(async (context) => {
            const fdb = context.firestore();
            const batch = fdb.batch();

            for (const entry of entries) {
                const ref = doc(fdb, 'timeEntries', entry.id);
                batch.set(ref, entry);
            }

            await batch.commit();
        });

        console.log(`[seed-history] Successfully seeded ${entries.length} entries.`);
        console.log('[seed-history] Done.');

    } catch (e) {
        console.error('[seed-history] Error:', e);
    } finally {
        await testEnv.cleanup();
    }
}

main();
