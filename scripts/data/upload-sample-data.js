import { db } from './src/firebase.js';
import { collection, doc, setDoc, Timestamp } from 'firebase/firestore';

/**
 * Sample Data Generator for Testing
 * Creates users and time entries to demonstrate all features
 */

// Sample users
const sampleUsers = [
    {
        uid: 'test-emp-1',
        email: 'john.doe@example.com',
        name: 'John Doe',
        role: 'employee',
        active: true,
        workSchedule: {
            type: 'full-time',
            timezone: 'America/Los_Angeles',
            workDays: [1, 2, 3, 4, 5],
            startTime: '08:00',
            endTime: '17:00',
            expectedLunchMin: 30,
            expectedLunchMax: 60,
            lateThresholdMinutes: 15,
            earlyLeaveThresholdMinutes: 15,
            stayLateThresholdMinutes: 30
        }
    },
    {
        uid: 'test-emp-2',
        email: 'jane.smith@example.com',
        name: 'Jane Smith',
        role: 'employee',
        active: true,
        workSchedule: {
            type: 'full-time',
            timezone: 'America/Los_Angeles',
            workDays: [1, 2, 3, 4, 5],
            startTime: '08:00',
            endTime: '17:00',
            expectedLunchMin: 30,
            expectedLunchMax: 60,
            lateThresholdMinutes: 15,
            earlyLeaveThresholdMinutes: 15,
            stayLateThresholdMinutes: 30
        }
    },
    {
        uid: 'test-emp-3',
        email: 'bob.wilson@example.com',
        name: 'Bob Wilson',
        role: 'employee',
        active: true,
        workSchedule: {
            type: 'part-time',
            timezone: 'America/Los_Angeles',
            workDays: [1, 3, 5],
            startTime: '09:00',
            endTime: '14:00',
            expectedLunchMin: 30,
            expectedLunchMax: 60
        }
    }
];

// Helper to create timestamp
function createTimestamp(dateStr, timeStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const [hours, minutes] = timeStr.split(':').map(Number);
    const date = new Date(year, month - 1, day, hours, minutes, 0);
    return Timestamp.fromDate(date);
}

// Sample time entries
function generateSampleEntries() {
    const entries = [];

    // John Doe - Good employee (normal entries)
    entries.push({
        userId: 'test-emp-1',
        workDate: '2025-12-09', // Monday
        clockInManual: '08:00',
        clockInSystemTime: createTimestamp('2025-12-09', '08:02'),
        clockInSubmitted: true,
        lunchOutManual: '12:00',
        lunchOutSystemTime: createTimestamp('2025-12-09', '12:01'),
        lunchOutSubmitted: true,
        lunchInManual: '12:30',
        lunchInSystemTime: createTimestamp('2025-12-09', '12:31'),
        lunchInSubmitted: true,
        clockOutManual: '17:00',
        clockOutSystemTime: createTimestamp('2025-12-09', '17:01'),
        clockOutSubmitted: true,
        dayComplete: true,
        currentStep: 'complete',
        lunchMinutes: 30,
        totalWorkMinutes: 510,
        regularMinutes: 480,
        otMinutes: 30,
        doubleTimeMinutes: 0,
        workWeekStartDate: '2025-12-08',
        completedAt: createTimestamp('2025-12-09', '17:01'),
        createdAt: createTimestamp('2025-12-09', '08:02'),
        createdBy: 'test-emp-1',
        updatedAt: createTimestamp('2025-12-09', '17:01'),
        updatedBy: 'test-emp-1'
    });

    // John Doe - Another normal day
    entries.push({
        userId: 'test-emp-1',
        workDate: '2025-12-10', // Tuesday
        clockInManual: '08:00',
        clockInSystemTime: createTimestamp('2025-12-10', '08:01'),
        clockInSubmitted: true,
        lunchOutManual: '12:00',
        lunchOutSystemTime: createTimestamp('2025-12-10', '12:00'),
        lunchOutSubmitted: true,
        lunchInManual: '12:30',
        lunchInSystemTime: createTimestamp('2025-12-10', '12:30'),
        lunchInSubmitted: true,
        clockOutManual: '17:00',
        clockOutSystemTime: createTimestamp('2025-12-10', '17:02'),
        clockOutSubmitted: true,
        dayComplete: true,
        currentStep: 'complete',
        lunchMinutes: 30,
        totalWorkMinutes: 510,
        regularMinutes: 480,
        otMinutes: 30,
        doubleTimeMinutes: 0,
        workWeekStartDate: '2025-12-08',
        completedAt: createTimestamp('2025-12-10', '17:02'),
        createdAt: createTimestamp('2025-12-10', '08:01'),
        createdBy: 'test-emp-1',
        updatedAt: createTimestamp('2025-12-10', '17:02'),
        updatedBy: 'test-emp-1'
    });

    // Jane Smith - SUSPICIOUS: Late clock in submission
    entries.push({
        userId: 'test-emp-2',
        workDate: '2025-12-09',
        clockInManual: '08:00',
        clockInSystemTime: createTimestamp('2025-12-09', '08:45'), // 45 min late!
        clockInSubmitted: true,
        lunchOutManual: '12:00',
        lunchOutSystemTime: createTimestamp('2025-12-09', '12:02'),
        lunchOutSubmitted: true,
        lunchInManual: '12:30',
        lunchInSystemTime: createTimestamp('2025-12-09', '12:32'),
        lunchInSubmitted: true,
        clockOutManual: '17:00',
        clockOutSystemTime: createTimestamp('2025-12-09', '17:01'),
        clockOutSubmitted: true,
        dayComplete: true,
        currentStep: 'complete',
        lunchMinutes: 30,
        totalWorkMinutes: 510,
        regularMinutes: 480,
        otMinutes: 30,
        doubleTimeMinutes: 0,
        workWeekStartDate: '2025-12-08',
        completedAt: createTimestamp('2025-12-09', '17:01'),
        createdAt: createTimestamp('2025-12-09', '08:45'),
        createdBy: 'test-emp-2',
        updatedAt: createTimestamp('2025-12-09', '17:01'),
        updatedBy: 'test-emp-2'
    });

    // Jane Smith - SUSPICIOUS: Batch submission (all at end of day)
    entries.push({
        userId: 'test-emp-2',
        workDate: '2025-12-10',
        clockInManual: '08:00',
        clockInSystemTime: createTimestamp('2025-12-10', '16:58'),
        clockInSubmitted: true,
        lunchOutManual: '12:00',
        lunchOutSystemTime: createTimestamp('2025-12-10', '16:59'),
        lunchOutSubmitted: true,
        lunchInManual: '12:30',
        lunchInSystemTime: createTimestamp('2025-12-10', '16:59'),
        lunchInSubmitted: true,
        clockOutManual: '17:00',
        clockOutSystemTime: createTimestamp('2025-12-10', '17:00'),
        clockOutSubmitted: true,
        dayComplete: true,
        currentStep: 'complete',
        lunchMinutes: 30,
        totalWorkMinutes: 510,
        regularMinutes: 480,
        otMinutes: 30,
        doubleTimeMinutes: 0,
        workWeekStartDate: '2025-12-08',
        completedAt: createTimestamp('2025-12-10', '17:00'),
        createdAt: createTimestamp('2025-12-10', '16:58'),
        createdBy: 'test-emp-2',
        updatedAt: createTimestamp('2025-12-10', '17:00'),
        updatedBy: 'test-emp-2'
    });

    // Bob Wilson - Part-time, normal
    entries.push({
        userId: 'test-emp-3',
        workDate: '2025-12-09', // Monday (works M/W/F)
        clockInManual: '09:00',
        clockInSystemTime: createTimestamp('2025-12-09', '09:01'),
        clockInSubmitted: true,
        lunchOutManual: '',
        lunchOutSystemTime: null,
        lunchOutSubmitted: true,
        lunchSkipped: true,
        lunchInManual: '',
        lunchInSystemTime: null,
        lunchInSubmitted: true,
        clockOutManual: '14:00',
        clockOutSystemTime: createTimestamp('2025-12-09', '14:01'),
        clockOutSubmitted: true,
        dayComplete: true,
        currentStep: 'complete',
        lunchMinutes: 0,
        totalWorkMinutes: 300,
        regularMinutes: 300,
        otMinutes: 0,
        doubleTimeMinutes: 0,
        workWeekStartDate: '2025-12-08',
        completedAt: createTimestamp('2025-12-09', '14:01'),
        createdAt: createTimestamp('2025-12-09', '09:01'),
        createdBy: 'test-emp-3',
        updatedAt: createTimestamp('2025-12-09', '14:01'),
        updatedBy: 'test-emp-3'
    });

    // John Doe - Overtime day (10 hours)
    entries.push({
        userId: 'test-emp-1',
        workDate: '2025-12-11', // Wednesday
        clockInManual: '08:00',
        clockInSystemTime: createTimestamp('2025-12-11', '08:01'),
        clockInSubmitted: true,
        lunchOutManual: '12:00',
        lunchOutSystemTime: createTimestamp('2025-12-11', '12:00'),
        lunchOutSubmitted: true,
        lunchInManual: '12:30',
        lunchInSystemTime: createTimestamp('2025-12-11', '12:31'),
        lunchInSubmitted: true,
        clockOutManual: '18:30',
        clockOutSystemTime: createTimestamp('2025-12-11', '18:31'),
        clockOutSubmitted: true,
        dayComplete: true,
        currentStep: 'complete',
        lunchMinutes: 30,
        totalWorkMinutes: 600,
        regularMinutes: 480,
        otMinutes: 120,
        doubleTimeMinutes: 0,
        workWeekStartDate: '2025-12-08',
        completedAt: createTimestamp('2025-12-11', '18:31'),
        createdAt: createTimestamp('2025-12-11', '08:01'),
        createdBy: 'test-emp-1',
        updatedAt: createTimestamp('2025-12-11', '18:31'),
        updatedBy: 'test-emp-1'
    });

    return entries;
}

// Upload sample data
async function uploadSampleData() {
    console.log('🔄 Uploading sample data...');

    try {
        // Upload users
        console.log('📝 Creating sample users...');
        for (const user of sampleUsers) {
            await setDoc(doc(db, 'users', user.uid), user);
            console.log(`✅ Created user: ${user.name}`);
        }

        // Upload time entries
        console.log('\n📝 Creating sample time entries...');
        const entries = generateSampleEntries();
        for (const entry of entries) {
            const entryId = `${entry.userId}_${entry.workDate}`;
            await setDoc(doc(db, 'timeEntries', entryId), entry);
            console.log(`✅ Created entry: ${entryId}`);
        }

        console.log('\n🎉 Sample data uploaded successfully!');
        console.log('\n📊 Summary:');
        console.log(`   Users: ${sampleUsers.length}`);
        console.log(`   Time Entries: ${entries.length}`);
        console.log('\n👥 Test Users:');
        console.log('   1. John Doe (test-emp-1) - Normal employee');
        console.log('   2. Jane Smith (test-emp-2) - Has suspicious entries');
        console.log('   3. Bob Wilson (test-emp-3) - Part-time employee');
        console.log('\n🔍 Try the Audit Viewer to see Jane\'s suspicious patterns!');

    } catch (error) {
        console.error('❌ Error uploading sample data:', error);
    }
}

// Run it
uploadSampleData();
