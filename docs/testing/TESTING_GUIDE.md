# 🧪 Testing Guide - Sample Data

## Quick Test with Sample Data

To test all features, add this sample data to Firebase Console:

### 📍 **Go to:** https://console.firebase.google.com
1. Select project: `atd-time-tracking`
2. Go to: **Firestore Database**
3. Add the documents below

---

## 👥 Sample Users (Collection: `users`)

### **Document ID:** `test-emp-1`
```json
{
  "uid": "test-emp-1",
  "email": "john.doe@example.com",
  "name": "John Doe",
  "role": "employee",
  "active": true,
  "workSchedule": {
    "type": "full-time",
    "timezone": "America/Los_Angeles",
    "workDays": [1,2,3,4,5],
    "startTime": "08:00",
    "endTime": "17:00"
  }
}
```

### **Document ID:** `test-emp-2`
```json
{
  "uid": "test-emp-2",
  "email": "jane.smith@example.com",
  "name": "Jane Smith",
  "role": "employee",
  "active": true,
  "workSchedule": {
    "type": "full-time",
    "timezone": "America/Los_Angeles",
    "workDays": [1,2,3,4,5],
    "startTime": "08:00",
    "endTime": "17:00"
  }
}
```

### **Document ID:** `test-emp-3`
```json
{
  "uid": "test-emp-3",
  "email": "bob.wilson@example.com",
  "name": "Bob Wilson",
  "role": "employee",
  "active": true,
  "workSchedule": {
    "type": "part-time",
    "timezone": "America/Los_Angeles",
    "workDays": [1,3,5],
    "startTime": "09:00",
    "endTime": "14:00"
  }
}
```

---

## ⏱️ Sample Time Entries (Collection: `timeEntries`)

### **Document ID:** `test-emp-1_2025-12-09` (Normal Entry)
```json
{
  "userId": "test-emp-1",
  "workDate": "2025-12-09",
  "clockInManual": "08:00",
  "clockInSubmitted": true,
  "lunchOutManual": "12:00",
  "lunchOutSubmitted": true,
  "lunchInManual": "12:30",
  "lunchInSubmitted": true,
  "clockOutManual": "17:00",
  "clockOutSubmitted": true,
  "dayComplete": true,
  "currentStep": "complete",
  "lunchMinutes": 30,
  "totalWorkMinutes": 510,
  "regularMinutes": 480,
  "otMinutes": 30,
  "doubleTimeMinutes": 0,
  "workWeekStartDate": "2025-12-08"
}
```

### **Document ID:** `test-emp-2_2025-12-10` (SUSPICIOUS - Batch Submit!)
```json
{
  "userId": "test-emp-2",
  "workDate": "2025-12-10",
  "clockInManual": "08:00",
  "clockInSubmitted": true,
  "lunchOutManual": "12:00",
  "lunchOutSubmitted": true,
  "lunchInManual": "12:30",
  "lunchInSubmitted": true,
  "clockOutManual": "17:00",
  "clockOutSubmitted": true,
  "dayComplete": true,
  "currentStep": "complete",
  "lunchMinutes": 30,
  "totalWorkMinutes": 510,
  "regularMinutes": 480,
  "otMinutes": 30,
  "doubleTimeMinutes": 0,
  "workWeekStartDate": "2025-12-08"
}
```

### **Document ID:** `test-emp-1_2025-12-11` (Overtime Day)
```json
{
  "userId": "test-emp-1",
  "workDate": "2025-12-11",
  "clockInManual": "08:00",
  "clockInSubmitted": true,
  "lunchOutManual": "12:00",
  "lunchOutSubmitted": true,
  "lunchInManual": "12:30",
  "lunchInSubmitted": true,
  "clockOutManual": "18:30",
  "clockOutSubmitted": true,
  "dayComplete": true,
  "currentStep": "complete",
  "lunchMinutes": 30,
  "totalWorkMinutes": 600,
  "regularMinutes": 480,
  "otMinutes": 120,
  "doubleTimeMinutes": 0,
  "workWeekStartDate": "2025-12-08"
}
```

---

## 🧪 Testing Scenarios

### **Test 1: View Normal Entry**
1. Go to: Manager Dashboard
2. Filter: John Doe, Dec 9-11
3. ✅ Should see 3 entries
4. Click "View Details" on Dec 9
5. ✅ Should show normal times

### **Test 2: See Suspicious Pattern (Audit Viewer)**
1. Go to: Admin → 🔍 Audit Viewer
2. Filter: Jane Smith, Dec 9-11
3. Check "Suspicious Only"
4. Click "Load Entries"
5. ✅ Should see Jane's Dec 10 entry flagged
6. ✅ Should show "Batch submission" warning

### **Test 3: Payroll Report**
1. Go to: Admin → 💰 Payroll Reports
2. Set dates: Dec 9-11
3. Select: All Employees
4. Click "Generate Report"
5. ✅ Should see totals for John, Jane, Bob
6. ✅ John should have OT hours (from Dec 11)

### **Test 4: Sequential Entry (Live)**
1. **Clear browser data** or use incognito
2. Create a NEW test employee in Firebase Authentication
3. Add their user document in Firestore
4. Login as that employee
5. Go to: Today's Entry
6. ✅ Should see Step 1: Clock In
7. Enter time → Submit
8. ✅ Should unlock Step 2
9. Continue through all steps
10. ✅ Should see completion summary

### **Test 5: Yesterday Blocking**
1. As test employee
2. Don't complete yesterday's entry
3. Try to access today's entry
4. ✅ Should be BLOCKED with message

---

## 🎯 What to Look For:

✅ **Sequential Entry:**
- Can't skip steps
- Each step unlocks after previous
- Progress tracker updates

✅ **Time Validation:**
- Can't enter illogical times
- Lunch Out must be after Clock In
- Clock Out must be after Lunch In

✅ **Audit Viewer:**
- Shows manual vs system times
- Calculates gaps
- Flags suspicious patterns

✅ **Payroll Reports:**
- Correctly calculates OT
- Shows regular, OT, and DT hours
- CSV export works

✅ **Manager Dashboard:**
- Can view team entries
- Red flags appear
- Details drill-down works

---

## ⚡ Quick Test (Without Manual Data Entry):

**Just test the Sequential Entry flow:**

1. Create Firebase Auth user:
   ```
   Email: test@example.com
   Password: test123456
   ```

2. Add to Firestore `users` collection:
   ```json
   {
     "uid": "[uid from Auth]",
     "name": "Test User",
     "email": "test@example.com",
     "role": "employee",
     "active": true
   }
   ```

3. Login and test step-by-step entry!

---

**Note:** To add system timestamps, you'll need to use Firebase Admin SDK or add them via console. For now, the app will create them automatically when employees submit entries going forward!
