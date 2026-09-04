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
Object.defineProperty(exports, "__esModule", { value: true });
const admin = __importStar(require("firebase-admin"));
const moment = __importStar(require("moment-timezone"));
// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        projectId: 'atd-time-tracking'
    });
}
const db = admin.firestore();
// Helpers
const parseToLocalTimeWithDate = (dateStr, timeStr, timeZone) => {
    // dateStr: YYYY-MM-DD, timeStr: HH:MM AM/PM or HH:mm
    // Returns the UTC millisecond value for the given wall-clock time *in the employee's timezone*.
    // IMPORTANT: we must honour `timeZone` here. The employee's punches are wall-clock in their
    // local zone (California / Turkey / Thailand), so the correct instant differs even though the
    // string looks identical. `moment-timezone` resolves that mapping (and DST) for us.
    let h = 0, m = 0;
    if (timeStr.includes('AM') || timeStr.includes('PM')) {
        const [time, modifier] = timeStr.split(' ');
        const [hours, minutes] = time.split(':');
        h = parseInt(hours, 10);
        m = parseInt(minutes, 10);
        if (h === 12)
            h = 0;
        if (modifier === 'PM')
            h += 12;
    }
    else {
        const [hours, minutes] = timeStr.split(':');
        h = parseInt(hours, 10);
        m = parseInt(minutes, 10);
    }
    const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return moment.tz(`${dateStr} ${hhmm}`, 'YYYY-MM-DD HH:mm', timeZone).valueOf();
};
const formatDateStr = (d) => {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const formatTimeHHMM = (h, m) => {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const timeToMinutes = (time) => {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
};
const calculateTotals = (entry) => {
    if (!entry.clockInManual || !entry.clockOutManual) {
        entry.totalWorkMinutes = 0;
        entry.totalHours = 0;
        return;
    }
    const clockIn = timeToMinutes(entry.clockInManual);
    const clockOut = timeToMinutes(entry.clockOutManual);
    let totalMinutes = clockOut - clockIn;
    if (entry.lunchOutManual && entry.lunchInManual && !entry.skipLunch) {
        totalMinutes -= (timeToMinutes(entry.lunchInManual) - timeToMinutes(entry.lunchOutManual));
    }
    // Wrap around for night shifts
    if (totalMinutes < 0)
        totalMinutes += 1440;
    entry.totalWorkMinutes = totalMinutes;
    entry.totalHours = totalMinutes / 60;
    // Overtime logic
    let regularMinutes = Math.min(totalMinutes, 8 * 60);
    let otMinutes = Math.max(0, Math.min(totalMinutes - 8 * 60, 4 * 60));
    let doubleTimeMinutes = Math.max(0, totalMinutes - 12 * 60);
    entry.regularMinutes = regularMinutes;
    entry.otMinutes = otMinutes;
    entry.doubleTimeMinutes = doubleTimeMinutes;
    entry.regularHours = regularMinutes / 60;
    entry.overtimeHours = otMinutes / 60;
    entry.doubleTimeHours = doubleTimeMinutes / 60;
};
// Data configuration
const TARGET_EMAIL = 'employee2@test.com';
const SCENARIOS = [
    { type: 'NORMAL', count: 14 },
    { type: 'MISSING_LUNCH', count: 3 },
    { type: 'MISSING_CLOCKOUT', count: 2 },
    { type: 'LONG_SHIFT', count: 2 },
    { type: 'EARLY', count: 1 },
    { type: 'LATE', count: 1 },
    { type: 'SHORT_SHIFT', count: 1 },
];
async function seedData() {
    console.log(`Starting data seed for ${TARGET_EMAIL}...`);
    // 1. Get user by email
    const usersSnap = await db.collection('users').where('email', '==', TARGET_EMAIL).limit(1).get();
    if (usersSnap.empty) {
        console.error(`User ${TARGET_EMAIL} not found in Firestore users coll.`);
        return;
    }
    const userDoc = usersSnap.docs[0];
    const uid = userDoc.id;
    console.log(`Found user ID: ${uid}`);
    // Fetch user doc for timezone
    let timeZone = 'America/Los_Angeles';
    const userData = userDoc.data();
    if (userData === null || userData === void 0 ? void 0 : userData.timezone) {
        timeZone = userData.timezone;
    }
    console.log(`Using timezone: ${timeZone}`);
    // 2. Generate dates
    const today = new Date();
    const datesToSeed = [];
    // Look back 35 days to find ~25 weekdays
    for (let i = 1; i <= 35; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dayOfWeek = d.getDay();
        const dateStr = formatDateStr(d);
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            // Keep one Saturday for the WEEKEND scenario
            if (dayOfWeek === 6 && !datesToSeed.some(x => x.isWeekend)) {
                datesToSeed.push({ date: d, dateStr, isWeekend: true });
            }
        }
        else {
            datesToSeed.push({ date: d, dateStr, isWeekend: false });
        }
    }
    // Sort chronologically
    datesToSeed.sort((a, b) => a.date.getTime() - b.date.getTime());
    // 3. Assign Scenarios
    let entriesData = [];
    let scenarioQueue = [];
    SCENARIOS.forEach(scen => {
        for (let i = 0; i < scen.count; i++) {
            scenarioQueue.push(scen.type);
        }
    });
    // Shuffle the queue for somewhat random distribution
    scenarioQueue.sort(() => Math.random() - 0.5);
    for (const dt of datesToSeed) {
        if (dt.isWeekend) {
            // Special WEEKEND scenario
            entriesData.push({
                dateStr: dt.dateStr,
                scenario: 'WEEKEND',
                times: { in: '09:15', lOut: '12:30', lIn: '13:00', out: '15:30' }
            });
            continue;
        }
        const scen = scenarioQueue.pop();
        if (!scen)
            break; // We run out of scenarios
        let times = { in: '08:05', lOut: '12:00', lIn: '12:30', out: '16:35' }; // NORMAL fallback
        if (scen === 'NORMAL') {
            const varIn = 8 + (Math.random() > 0.5 ? 0 : -0.25);
            times.in = formatTimeHHMM(Math.floor(varIn), Math.floor((varIn % 1) * 60));
            times.lOut = '12:00';
            times.lIn = '12:30';
            const varOut = 16 + (Math.random() > 0.3 ? 0.5 : 0.75);
            times.out = formatTimeHHMM(Math.floor(varOut), Math.floor((varOut % 1) * 60));
        }
        else if (scen === 'MISSING_LUNCH') {
            times.in = '08:10';
            times.lOut = '';
            times.lIn = '';
            times.out = '16:45';
        }
        else if (scen === 'MISSING_CLOCKOUT') {
            times.in = '08:00';
            times.lOut = '12:00';
            times.lIn = '12:30';
            times.out = '';
        }
        else if (scen === 'LONG_SHIFT') {
            times.in = '07:30';
            times.lOut = '12:00';
            times.lIn = '12:30';
            times.out = '18:30';
        }
        else if (scen === 'EARLY') {
            times.in = '05:45';
            times.lOut = '10:30';
            times.lIn = '11:00';
            times.out = '14:30';
        }
        else if (scen === 'LATE') {
            times.in = '09:00';
            times.lOut = '13:00';
            times.lIn = '13:30';
            times.out = '19:00';
        }
        else if (scen === 'SHORT_SHIFT') {
            times.in = '09:00';
            times.lOut = '09:40';
            times.lIn = '10:10';
            times.out = '12:30';
        }
        entriesData.push({
            dateStr: dt.dateStr,
            scenario: scen,
            times
        });
    }
    // 4. Create in Firestore
    let createdCount = 0;
    let skippedCount = 0;
    const summaryCount = {};
    for (const item of entriesData) {
        const docId = `${uid}_${item.dateStr}`;
        const docRef = db.collection('timeEntries').doc(docId);
        const existing = await docRef.get();
        if (existing.exists) {
            skippedCount++;
            continue;
        }
        const e = {
            id: docId,
            userId: uid,
            date: item.dateStr,
            workDate: item.dateStr,
            seeded: true,
            seededBatchId: 'seed_v1_month_mix',
            seededAt: admin.firestore.FieldValue.serverTimestamp(),
            seededScenario: item.scenario,
        };
        if (item.times.in) {
            e.clockInManual = item.times.in;
            e.clockInSystem = parseToLocalTimeWithDate(item.dateStr, item.times.in, timeZone);
            e.currentStep = 1;
        }
        if (item.times.lOut) {
            e.lunchOutManual = item.times.lOut;
            e.lunchOutSystem = parseToLocalTimeWithDate(item.dateStr, item.times.lOut, timeZone);
            e.currentStep = 2;
        }
        if (item.times.lIn) {
            e.lunchInManual = item.times.lIn;
            e.lunchInSystem = parseToLocalTimeWithDate(item.dateStr, item.times.lIn, timeZone);
            e.currentStep = 3;
        }
        if (item.times.out) {
            e.clockOutManual = item.times.out;
            e.clockOutSystem = parseToLocalTimeWithDate(item.dateStr, item.times.out, timeZone);
            e.currentStep = 4;
            e.complete = !!(item.times.in && item.times.lOut && item.times.lIn && item.times.out);
            e.dayComplete = e.complete;
        }
        else {
            e.complete = false;
            e.dayComplete = false;
        }
        if (item.scenario === 'MISSING_LUNCH') {
            e.skipLunch = false;
            e.complete = false;
            e.dayComplete = false;
        }
        calculateTotals(e);
        await docRef.set(e);
        createdCount++;
        summaryCount[item.scenario] = (summaryCount[item.scenario] || 0) + 1;
    }
    console.log('\n--- SEEDING COMPLETE ---');
    console.log(`Total entries created: ${createdCount}`);
    console.log(`Total skipped (already existed): ${skippedCount}`);
    if (entriesData.length > 0) {
        const dates = entriesData.map(e => e.dateStr).sort();
        console.log(`Date range used: ${dates[0]} to ${dates[dates.length - 1]}`);
    }
    console.log('\nCount by Scenario:');
    Object.entries(summaryCount).forEach(([scenario, count]) => {
        console.log(`- ${scenario}: ${count}`);
    });
}
seedData().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=seed.js.map