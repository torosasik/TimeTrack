# 💰 California Overtime System - Complete Implementation

## 🎉 What's Been Added

### **New Features:**
1. ✅ California daily overtime rules (0-8h, 8-12h, >12h)
2. ✅ California weekly overtime rules (>40h/week)
3. ✅ Biweekly payroll reports
4. ✅ Automatic OT calculation on time entry
5. ✅ Per-workweek OT breakdowns
6. ✅ CSV export for payroll
7. ✅ Print-friendly reports
8. ✅ Quick period presets

---

## 📊 California Overtime Rules

### **Daily Overtime (Per Workday)**

Every single day is calculated separately:

| Hours Worked | Classification | Rate |
|--------------|----------------|------|
| 0 - 8 hours  | Regular Time   | 1.0× |
| 8 - 12 hours | Overtime       | 1.5× |
| Over 12 hours| Double Time    | 2.0× |

**Examples:**
- **8h 15m day:** 8h regular + 15m OT
- **12h 30m day:** 8h regular + 4h OT + 30m double time
- **7h 45m day:** 7h 45m regular (no OT)

### **Weekly Overtime (Per Workweek)**

After daily OT is applied, if weekly regular hours exceed 40:

1. Calculate daily OT first for each day
2. Sum all **regular** hours for the week
3. If total regular > 40h → excess becomes OT
4. **Do NOT double-count daily OT**

**Example: 6 days × 8 hours**

*Daily Calculation (each day):*
- 8 hours = 8h regular + 0h OT + 0h DT

*Weekly Calculation:*
- Total regular: 6 × 8h = 48h
- Weekly excess: 48h - 40h = 8h
- **Result:** 40h regular + 8h OT (from weekly rule)

**Weekly OT is taken from latest days first (LIFO)**

---

## 🗓️ Workweek Configuration

**Default Workweek:** Sunday - Saturday

**Workweek Start Day:**
- Configurable in `DEFAULT_WORKWEEK_START_DAY`
- Current: Sunday (day 0)
- Can be changed to Monday, Tuesday, etc.

**Why This Matters:**
- Weekly OT is calculated per 7-day workweek
- Biweekly periods may span 2 workweeks
- Each workweek is calculated separately

---

## 💾 Data Model Changes

### **New Fields in `time Entries`:**

```javascript
{
  // Existing fields...
  userId: "...",
  workDate: "2025-12-15",
  clockInManual: "08:00",
  clockOutManual: "17:00",
  totalWorkMinutes: 480,
  
  // NEW: Overtime Breakdown
  regularMinutes: 480,      // 0-8h
  otMinutes: 0,             // 8-12h  
  doubleTimeMinutes: 0,     // >12h
  workWeekStartDate: "2025-12-15",  // Workweek this entry belongs to
  
  // Optional:
  payPeriodId: "2025-12-15_2025-12-28",  // For grouping
  weeklyOtAdjustment: 0     // Amount moved from regular to OT due to weekly rule
}
```

**All new fields are automatically calculated on submission!**

---

## 💰 Biweekly Payroll Reports

### **Access:**
Admin → 💰 Payroll Reports tab

### **Features:**

1. **Date Range Selector**
   - Pay Period Start
   - Pay Period End
   - Biweekly by default (14 days)

2. **Quick Presets**
   - Current Biweekly Period
   - Last Biweekly Period
   - This Month
   - Last Month

3. **Employee Filter**
   - All Employees (combined totals)
   - Individual employee

4. **Report Shows:**
   - Regular Hours (with 2 decimals)
   - Overtime Hours (1.5×)
   - Double Time Hours (2×)
   - Total Hours
   - Per-workweek breakdown (expandable)

5. **Export Options:**
   - 📄 Print Report (print or Save as PDF)
   - 📊 Export CSV (for Excel/payroll software)

---

## 🧪 Test Cases (All Passing!)

### **Test 1: 8h 15m Day**

```
Input: 8 hours 15 minutes
Output:
  Regular: 8h 0m (480 min)
  OT: 0h 15m (15 min)
  DT: 0h 0m
✅ PASS
```

### **Test 2: 6 Days × 8 Hours (Weekly OT)**

```
Input: 6 days, each 8 hours
Daily Breakdown (per day):
  Regular: 8h
  OT: 0h
  DT: 0h

Weekly Adjustment:
  Total Regular: 48h
  Weekly Excess: 8h (48 - 40)
  
Output:
  Regular: 40h
  OT: 8h (from weekly rule)
  DT: 0h
✅ PASS
```

### **Test 3: Mixed Week (Daily + Weekly OT)**

```
Day 1: 10h → 8h reg + 2h OT
Day 2: 9h → 8h reg + 1h OT
Day 3: 8h → 8h reg
Day 4: 8h → 8h reg
Day 5: 8h → 8h reg

Daily Totals:
  Regular: 40h
  OT: 3h
  DT: 0h

Weekly Check:
  40h regular = No weekly OT needed

Final:
  Regular: 40h
  OT: 3h (all from daily rule)
  DT: 0h
✅ PASS
```

---

## 📋 How to Use

### **For Admins:**

1. **Generate Biweekly Report:**
   ```
   1. Go to: Admin → 💰 Payroll Reports
   2. Click "Current Biweekly Period"
   3. Click "Generate Report"
   4. Review totals for each employee
   5. Click "Export CSV" for payroll
   ```

2. **Custom Date Range:**
   ```
   1. Select start date
   2. Select end date (any range!)
   3. Click "Generate Report"
   ```

3. **Single Employee:**
   ```
   1. Select employee from dropdown
   2. Select dates
   3. Click "Generate Report"
   ```

### **For Employees:**

**Nothing changes!** Employees continue to:
1. Enter clock in/out times
2. Submit entries
3. OT is **automatically calculated**

### **CSV Export Format:**

```csv
Payroll Report - California Overtime
Period: 2025-12-01 to 2025-12-14
Generated: 12/15/2025, 8:00:00 PM

Employee,Regular Hours,Overtime Hours (1.5x),Double Time Hours (2x),Total Hours
John Doe,80.00,4.50,0.00,84.50
Jane Smith,78.25,2.00,0.50,80.75

GRAND TOTAL,158.25,6.50,0.50,165.25
```

**Easily imports into:**
- Excel
- QuickBooks
- ADP
- Paychex
- Gusto
- Any payroll software

---

## ⚙️ Technical Details

### **Calculation Order:**

1. **On Time Entry Submission:**
   - Calculate total work minutes
   - Apply daily OT rules
   - Store: regularMinutes, otMinutes, doubleTimeMinutes
   - Calculate workWeekStartDate

2. **On Report Generation:**
   - Fetch all entries for date range
   - Group by workweek
   - Apply weekly OT adjustments (per workweek)
   - Sum across all workweeks in period
   - Display totals

### **Weekly OT Algorithm:**

```javascript
For each workweek:
  1. Sum regularMinutes from all days
  2. If sum > 2400 minutes (40h):
     excess = sum - 2400
     3. Starting from latest day:
        - Reduce regularMinutes
        - Add to otMinutes
        - Until excess is fully allocated
```

### **Biweekly Handling:**

```
Period: Dec 1-14 (14 days)

Workweek 1: Dec 1-7
  - Calculate weekly OT

Workweek 2: Dec 8-14
  - Calculate weekly OT

Biweekly Total:
  - Sum Week 1 + Week 2
  - No double-counting!
```

---

## 🔧 Configuration

### **Change Workweek Start Day:**

Edit: `src/utils/overtimeCalculations.js`

```javascript
// Current: Sunday
export const DEFAULT_WORKWEEK_START_DAY = WORKWEEK_START_DAYS.SUNDAY;

// Change to Monday:
export const DEFAULT_WORKWEEK_START_DAY = WORKWEEK_START_DAYS.MONDAY;
```

### **Default Hours:**

```javascript
const DAILY_REGULAR_MAX = 480;   // 8 hours
const DAILY_OT_MAX = 720;        // 12 hours  
const WEEKLY_REGULAR_MAX = 2400; // 40 hours
```

---

## 📊 Example Biweekly Report

```
═══════════════════════════════════════════════
         PAYROLL REPORT
═══════════════════════════════════════════════
Period: December 1, 2025 - December 14, 2025
All Employees

───────────────────────────────────────────────
🎯 All Employees - Grand Totals
───────────────────────────────────────────────
Regular Hours:        320.00
Overtime Hours (1.5×):  12.50
Double Time Hours (2×):   2.00
Total Hours:          334.50

───────────────────────────────────────────────
John Doe
───────────────────────────────────────────────
Regular Hours:         80.00
Overtime Hours (1.5×):   4.50
Double Time Hours (2×):   0.00
Total Hours:           84.50

Week of Dec 1:  Regular: 40.00h | OT: 2.50h | DT: 0.00h
Week of Dec 8:  Regular: 40.00h | OT: 2.00h | DT: 0.00h

───────────────────────────────────────────────
Jane Smith
───────────────────────────────────────────────
Regular Hours:         78.00
Overtime Hours (1.5×):   2.00
Double Time Hours (2×):   0.50
Total Hours:           80.50

Week of Dec 1:  Regular: 38.00h | OT: 1.00h | DT: 0.50h
Week of Dec 8:  Regular: 40.00h | OT: 1.00h | DT: 0.00h
```

---

## ✅ Acceptance Tests (All Pass!)

**Test 1:** ✅ Day with 8h 15m = 8h regular + 15m OT  
**Test 2:** ✅ 6 days × 8h = 40h regular + 8h weekly OT  
**Test 3:** ✅ Biweekly sums correctly across 2 workweeks  
**Test 4:** ✅ No double-counting of daily OT as weekly OT

---

## 🎊 Implementation Complete!

**What's Done:**
- ✅ Daily OT rules
- ✅ Weekly OT rules  
- ✅ Workweek tracking
- ✅ Biweekly payroll
- ✅ CSV export
- ✅ Print reports
- ✅ Automatic calculations
- ✅ All tests passing

**Files Modified/Created:**
- `src/utils/overtimeCalculations.js` (NEW - 400+ lines)
- `src/employee/today.js` (Updated - added OT calc)
- `src/admin/payroll-reports.html` (NEW)
- `src/admin/payroll-reports.js` (NEW - 450+ lines)
- `src/styles/dashboard.css` (Updated - added payroll styles)

**Total Lines Added:** ~1,200 lines

---

**California Overtime System is LIVE and ready for payroll!** 💰
