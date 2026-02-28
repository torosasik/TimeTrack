# 🛡️ Anti-Cheating & Time Integrity System - Implementation Plan

## ⚠️ CRITICAL REQUIREMENTS

This system MUST enforce process-based controls without surveillance.

**Required Protections (8 Total):**

1. ✅ Sequential Entry (step-by-step, no batch submit)
2. ✅ No Editing After Submit (already implemented)
3. ✅ Time Window Lock (same day or until 10am next day)
4. ✅ Yesterday Blocking (refined with Clock Out check)
5. ✅ System vs Manual Time Audit (dual timestamps)
6. ✅ Daily Deadline (11:59pm or 10am grace)
7. ✅ Lunch Enforcement (both or neither, flags)
8. ✅ Pattern Review (admin tool for trends)

---

## 🔧 Technical Implementation

### **1. Sequential Entry System**

**Current Flow (WRONG):**
```
Employee enters all times → Submit once → Done
```

**New Flow (CORRECT):**
```
Step 1: Enter Clock In → Submit
  ↓
Step 2: Enter Lunch Out → Submit (unlocked)
  ↓
Step 3: Enter Lunch In → Submit (unlocked)
  ↓  
Step 4: Enter Clock Out → Submit (unlocked)
  ↓
Day Complete (locked)
```

**Data Model:**
```javascript
{
  // Step 1
  clockInManual: "08:00",
  clockInSystemTime: Timestamp,
  clockInSubmitted: true,
  
  // Step 2
  lunchOutManual: "12:00",
  lunchOutSystemTime: Timestamp,
  lunchOutSubmitted: true,
  
  // Step 3
  lunchInManual: "12:30",
  lunchInSystemTime: Timestamp,
  lunchInSubmitted: true,
  
  // Step 4
  clockOutManual: "17:00",
  clockOutSystemTime: Timestamp,
  clockOutSubmitted: true,
  
  // Completion tracking
  currentStep: 1-4 or "complete",
  dayComplete: false/true,
  completedAt: Timestamp
}
```

### **2. Time Window Validation**

**Rules:**
- Can enter time same calendar day
- Grace period until 10am next day
- After 10am next day = LOCKED

**Implementation:**
```javascript
function canEditEntry(workDate) {
  const now = new Date();
  const entryDate = new Date(workDate + 'T00:00:00');
  
  // Same day = always OK
  if (isSameDay(now, entryDate)) return true;
  
  // Next day before 10am = OK
  if (isNextDay(now, entryDate)) {
    const hour = now.getHours();
    return hour < 10;
  }
  
  // Otherwise locked
  return false;
}
```

### **3. System Timestamps**

**For Each Step:**
- Manual time: Employee enters "08:00"
- System time: Firestore server timestamp
- Gap calculation: Compare manual vs system

**Flags (Admin Only):**
```javascript
{
  clockInFlag: {
    manualTime: "08:00",
    systemTime: "2025-12-15T08:45:00",
    gapMinutes: 45,
    suspicious: true  // >30 min gap
  }
}
```

### **4. Yesterday Blocking (Enhanced)**

**Check on Login:**
```javascript
async function checkYesterday() {
  const yesterday = getYesterdayDate();
  const entry = await getEntry(userId, yesterday);
  
  // No entry = block
  if (!entry) return {
    blocked: true,
    reason: "No entry for yesterday"
  };
  
  // Missing Clock Out = block
  if (!entry.clockOutSubmitted) return {
    blocked: true,
    reason: "Yesterday's entry incomplete (no Clock Out)"
  };
  
  // All good
  return { blocked: false };
}
```

### **5. Daily Deadline**

**Grace Period:**
- Workday: Today
- Deadline: 11:59pm today OR 10am tomorrow
- After: Read-only, requires admin

**Check:**
```javascript
function isPastDeadline(workDate) {
  const now = new Date();
  const entryDate = new Date(workDate + 'T00:00:00');
  
  // More than 1 day old
  if (daysSince(entryDate) > 1) return true;
  
  // 1 day old + past 10am
  if (daysSince(entryDate) === 1 && now.getHours() >= 10) {
    return true;
  }
  
  return false;
}
```

### **6. Lunch Enforcement**

**Rules:**
- Both Lunch Out + Lunch In OR neither
- Cannot submit Clock Out without Lunch In (if Lunch Out exists)
- Flags: <30min or >60min

**Already Implemented:** ✅ (just needs integration)

### **7. Pattern Review (Admin)**

**Metrics to Track:**
```javascript
{
  userId: "...",
  patterns: {
    sameClockInCount: 15,  // Same time 15 days
    minimumLunchCount: 12,  // 30min lunch 12 times
    lateSubmitCount: 8,     // Submitted near deadline 8 times
    correctionCount: 5,     // Required corrections 5 times
    avgClockIn: "08:03",
    avgClockOut: "17:02"
  }
}
```

### **8. Audit Trail**

**Full Tracking:**
```javascript
{
  createdAt: Timestamp,
  createdBy: "uid",
  updatedAt: Timestamp,
  updatedBy: "uid",
  editHistory: [
    {
      timestamp: Timestamp,
      editedBy: "uid",
      field: "clockInManual",
      oldValue: "08:00",
      newValue: "08:15",
      reason: "Manager correction"
    }
  ]
}
```

---

## 🎯 UI Changes

### **Employee View:**

**Before:**
```
[Clock In: _____]
[Lunch Out: _____]
[Lunch In: _____]
[Clock Out: _____]
[Submit All]
```

**After:**
```
Step 1: Clock In
[08:00] [Submit] ✅

Step 2: Lunch Out  
[12:00] [Submit] ✅

Step 3: Lunch In
[12:30] [Submit] ✅

Step 4: Clock Out
[     ] [Submit] ← CURRENT

[View Today's Summary]
```

### **Admin View:**

**Audit Details:**
```
John Doe - Dec 15, 2025

Clock In:   08:00 (manual)
            08:43 (system)  🚩 43 min gap

Lunch Out:  12:00 (manual)
            12:02 (system)  ✅ 2 min gap

Lunch In:   12:30 (manual)
            12:31 (system)  ✅ 1 min gap

Clock Out:  17:00 (manual)
            17:01 (system)  ✅ 1 min gap

🚩 Flags:
- Late Clock In submission (43 min gap)
- All steps submitted between 8:43-17:01 (suspicious)
```

---

## ⚠️ Critical Constraints

**MUST NOT:**
- ❌ Use GPS tracking
- ❌ Take screenshots
- ❌ Use camera
- ❌ Log keystrokes
- ❌ Auto-discipline employees
- ❌ Change times automatically

**MUST:**
- ✅ Use server timestamps
- ✅ Enforce process rules
- ✅ Flag for review (not punish)
- ✅ Require manager corrections
- ✅ Keep audit trail
- ✅ Be California-compliant

---

## 📊 Acceptance Tests

**Test 1:** ✅ Employee CANNOT submit all at once
**Test 2:** ✅ Employee CANNOT edit submitted steps
**Test 3:** ✅ Yesterday incomplete BLOCKS today
**Test 4:** ✅ Entries LOCKED after time window
**Test 5:** ✅ Lunch rules FLAG correctly
**Test 6:** ✅ Admin SEES audit timestamps
**Test 7:** ✅ Employee CANNOT see audit timestamps
**Test 8:** ✅ Sequential entry ENFORCED

---

## 🚀 Implementation Priority

**Phase 1 (Critical):**
1. Sequential entry system
2. Time window locks
3. System timestamps
4. Enhanced yesterday blocking

**Phase 2 (Important):**
5. Pattern review dashboard
6. Edit history tracking
7. Admin audit viewer

**Phase 3 (Nice-to-have):**
8. Reports with flags
9. Automated weekly summaries
10. Suspicious pattern alerts

---

## 📁 Files to Create/Modify

**New Files:**
1. `src/utils/timeIntegrity.js` - All validation logic
2. `src/admin/audit-viewer.html` - Audit trail UI
3. `src/admin/audit-viewer.js` - Audit logic
4. `src/admin/pattern-review.html` - Pattern analysis
5. `src/admin/pattern-review.js` - Pattern detection

**Modified Files:**
1. `src/employee/today.html` - Sequential UI
2. `src/employee/today.js` - Step-by-step logic
3. `firestore.rules` - Prevent bulk updates
4. Time entry schema - Add system timestamps

---

## ⏱️ Estimated Implementation Time

- Sequential Entry: 2-3 hours
- Time Windows: 1 hour
- System Timestamps: 1 hour
- Admin Audit View: 2 hours
- Pattern Review: 2-3 hours

**Total:** 8-10 hours of intensive development

---

**This is California-compliant, legally defensible, and fair to employees while preventing time abuse.** ✅

**Ready to start implementation?** This will be the biggest refactor yet, but absolutely critical for integrity.
