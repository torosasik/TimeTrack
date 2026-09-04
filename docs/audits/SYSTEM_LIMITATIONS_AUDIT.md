# System Limitations Audit

**Date:** 2026-07-17
**Scope:** Identification of all hardcoded business-logic, validation, and UI boundaries that constrain the time tracker, with focus on the reported "8-hour workday cap" perception.
**Method:** Static scan of `src/`, `functions/`, `firestore.rules`, and supporting utilities. Each finding lists the exact file:line, the user impact, and a remediation path.

---

## Summary

The reported "8-hour cap" is **not a hard enforcement** — an employee can work and record more than 8 hours. The number `8` appears in three places, none of which block entry:
1. The daily **regular-time** classification threshold in California overtime math (8h is where OT *starts*, not a ceiling).
2. The progress-bar "target" on the legacy `TodayEntry` complete screen (cosmetic).
3. Hardcoded schedule defaults in `scheduleHelpers.js` (`endTime: '17:00'`, i.e. an 8-hour span assumption).

There is, however, a **genuine hard cap**: the legacy `TodayEntry` auto-close watchdog forces a clock-out at **12 hours** of elapsed shift time and writes that capped timestamp to the database. That is the most consequential limitation found. Details below, ordered by severity.

---

## Limitations Found

### 1. CRITICAL — Auto-close watchdog hard-caps shifts at 12 hours and writes a capped (incorrect) timestamp

- **Limitation:** If an employee's open shift exceeds 12 hours of elapsed time, the legacy `TodayEntry` component silently auto-closes the shift, writing `clockOutManual` = clock-in + 12h and marking the entry complete. The capped value is persisted to Firestore as if the employee actually left at that time. There is no audit-log entry for this auto-close.
- **Location:** `src/app/components/employee/TodayEntry.tsx:79` (`const MAX_SHIFT_HOURS = 12;`) and the watchdog effect at `src/app/components/employee/TodayEntry.tsx:128-160` (cap enforced at lines `135-136`).
- **Impact:**
  - An employee working a legitimate 14h day (on-call, double coverage, etc.) has their record silently truncated to 12h — 2 paid hours vanish from the backend.
  - The capped `clockOutManual` is derived via `new Date(capMs).getHours()` (line `138`), which uses the **runtime's local timezone**, not canonical `America/Los_Angeles` — violating AGENTS.md §2. On a UTC server this writes a clock-out off by up to 8 hours from the intended PT value.
  - No `auditLogs` entry is produced, violating the mandatory-audit rule (`AGENTS.md` / `.kilo/rules/audit-mandatory-reason.md`) — this is an automated *correction* to a time record with no reason recorded.
  - Only affects the legacy `TodayEntry` path (`?classic=1`); the primary `ClockPunch` flow has no such cap.
- **Recommendation:** Remove the cap entirely, or convert it to a *notification-only* nudge ("You've been clocked in for 12h — did you forget to clock out?") that does not write data. If a hard cap is genuinely desired for policy, it must (a) use `America/Los_Angeles` formatting, (b) write a `voided`/correction via the audit log with a system reason, and (c) be configurable. At minimum, route the auto-close through `clockService.punchOut` so segments + audit are handled correctly.

### 2. Daily regular-time threshold of 8 hours (California OT rule — correct, but the source of the "cap" perception)

- **Limitation:** `calculateDailyOvertimeBreakdown` classifies minutes 0–480 as "regular", 480–720 as OT, >720 as double time. This is **not** a cap — it is the legal CA boundary where *pay rate* changes. Hours above 8 are still fully counted; they are just bucketed as OT/DT.
- **Location:** `src/utils/overtimeCalculations.ts:27` (`const DAILY_REGULAR_MAX = 480; // 8 hours`) and the bucketing at `src/utils/overtimeCalculations.ts:79-91`.
- **Impact:** None on totals — total hours are always `regular + ot + doubleTime`. But employees seeing "8.00h Regular" after a 10h day may misread this as a cap. The Payroll UI reinforces this wording: `src/app/components/admin/PayrollReports.tsx:480` ("First 8 hours per day, up to 40 per week").
- **Recommendation:** No code change needed. Consider a UI clarification ("8.00h Regular + 2.00h Overtime = 10.00h Total") so the breakdown is unambiguous.

### 3. Weekly regular-time threshold of 40 hours (California weekly OT rule)

- **Limitation:** Regular time beyond 40h/week is converted to OT, taken LIFO from the latest day. Again not a cap — excess becomes OT, it is not dropped.
- **Location:** `src/utils/overtimeCalculations.ts:29` (`const WEEKLY_REGULAR_MAX = 2400; // 40 hours`) and the LIFO adjustment at `src/utils/overtimeCalculations.ts:117-172`.
- **Impact:** None on totals; affects only the regular-vs-OT split used for payroll rates. Correct by CA law.
- **Recommendation:** No change. Constants are already named and could be parameterized per jurisdiction if multi-state support is ever needed.

### 4. Progress bar targets a hardcoded 8-hour "full day"

- **Limitation:** On the legacy complete-day view, the progress bar uses a fixed `targetHours = 8` and caps visual fill at 100% even if the employee worked longer.
- **Location:** `src/app/components/employee/TodayEntry.tsx:630-633` (`const targetHours = 8;` and `Math.min(100, ...)`).
- **Impact:** Cosmetic only — a 10h day shows "100% of 8:00" with an amber bar; the actual `totalHours` displayed separately is correct. May reinforce the "8h cap" misconception.
- **Recommendation:** Make the target configurable from `systemSettings`, or remove the cap so the bar can exceed 100% for long days. Low priority.

### 5. Hardcoded full-time schedule defaults assume 08:00–17:00, Mon–Fri

- **Limitation:** The default schedule used by red-flag detection assumes an 8-hour span (08:00–17:00 with a 30–60 min lunch) on weekdays only. This drives "late arrival / left early / wrong day" warnings.
- **Location:** `src/utils/scheduleHelpers.js:24-35` (`startTime: '08:00'`, `endTime: '17:00'`, `workDays: [1,2,3,4,5]`, `expectedLunchMin: 30`, `expectedLunchMax: 60`).
- **Impact:** Part-time, night-shift, weekend, or 4×10 employees trigger spurious "late/early/wrong-day" red flags because their reality doesn't match the hardcoded template.
- **Recommendation:** Move schedule config to a per-employee or per-team `schedule` document (the `User` type already has a `timezone` field — extend it). Keep these as fallback defaults only.

### 6. Anomaly warnings use fixed 06:00 / 18:00 / 12h / 60min heuristics

- **Limitation:** `checkTimeAnomalies` flags clock-ins before 06:00, clock-outs after 18:00, intervals <60min, and shifts >12h as "unusual — please confirm". These are advisory (block nothing) but are fixed constants.
- **Location:** `src/utils/timeValidation.ts:282` (before 6:00), `:292` (after 18:00), `:305` (<60min interval), `:318` (>12h shift).
- **Impact:** Early-bird or evening-shift workers see repeated confirmation prompts. Harmless but noisy.
- **Recommendation:** Tie thresholds to the employee's schedule (see #5) or make them admin-configurable. Low priority since they are non-blocking.

### 7. "One open shift per day" invariant (by design, but blocks legitimate split-shift re-open)

- **Limitation:** `validateCanPunchIn` blocks a new punch-in if any open segment exists for the PT workDate. This is the intended single-open-segment invariant. Split shifts are supported only by *closing* the prior segment first.
- **Location:** `src/utils/timeValidation.ts:371-379` (`validateCanPunchIn`) via `hasOpenSegmentLocal` at `:350-365`.
- **Impact:** Correct behavior; documented to prevent double-shift races. No remediation needed — listed for completeness.

### 8. Legacy `getAllTimeEntries` pagination (was a 500-doc silent cap; now paginated)

- **Limitation:** Historical concern. The method previously truncated at 500 docs, silently dropping payroll history for companies >~5 weeks of data.
- **Location:** `src/app/lib/database.ts:422-449` (now paginates with `PAGE_SIZE = 500` and loops until exhausted).
- **Impact:** Resolved — full history is now returned. The `limit(500)` at `src/app/lib/database.ts:566` (in `getRecentTimeEntries`-style helpers) is intentional for dashboard views.
- **Recommendation:** No change; keep the pagination loop. Listed so reviewers know the historical trap was already fixed.

### 9. ✅ RESOLVED — Payroll OT workweek-start default now Monday-aligned with the display week

- **Status:** **Complete (2026-07-18).** Fix applied after Kilo bot review flagged the divergence on the `getPTWeekStart` Monday-start PR.
- **Limitation (historical):** Two conflicting defaults existed for the workweek start day. `overtimeCalculations.DEFAULT_WORKWEEK_START_DAY = SUNDAY (0)`, while `PayrollReports` payroll settings defaulted `weekly_start_day` to `1` (Monday) and the display week (`getPTWeekStart` → `getWeekSummary` "This Week Total Hours") moved to Monday. Result: the display total and the weekly-OT (>40h) calculation summed over different 7-day windows (Mon–Sun vs Sun–Sat) — a Sunday shift landed in one boundary for display and another for OT.
- **Location:** `src/utils/overtimeCalculations.ts:24` (`DEFAULT_WORKWEEK_START_DAY`) vs `src/app/components/admin/PayrollReports.tsx:42,54` (`weekly_start_day: 1`) vs `src/utils/timeCalculations.ts` `getPTWeekStart`.
- **Fix applied:**
  - Changed `DEFAULT_WORKWEEK_START_DAY` from `WORKWEEK_START_DAYS.SUNDAY` to `WORKWEEK_START_DAYS.MONDAY` (`overtimeCalculations.ts:24`), aligning the OT engine default with the display week. This propagates to `getWorkWeekStartDate` (default arg), `calculateBiweeklyOvertimeTotals` (default arg), and the three explicit callers (TodayEntry, TeamDashboard, AdminPanel) that pass `DEFAULT_WORKWEEK_START_DAY`.
  - Added a cross-module **agreement test** in `overtimeCalculations.test.ts` (`workweek boundary agreement — display vs OT`) asserting `getWorkWeekStartDate(d)` (default arg) === `getPTWeekStart(d)` across 8 sample dates spanning a week boundary and a month boundary, plus a constant-is-Monday assertion. Locks the two boundaries together so the regression can't silently recur.
  - Updated affected default-dependent test assertions (constant value, default-arg week-start, biweekly week-key labels).
- **Verified safe (no migration):** `calculateBiweeklyOvertimeTotals` recomputes the week boundary from `entry.workDate` (line 236), not the stored `workWeekStartDate` field. `getEntriesForWorkweek` is test-only. Existing docs are bucketed under the new Monday boundary correctly on read; the stored field is informational-only.
- **Recommendation:** None — resolved. The agreement test is the ongoing guard.

### 10. Audit-history query capped at 50 results

- **Limitation:** `getAuditHistoryForEntry` defaults to `max: 50` and the method is currently stubbed/future-flagged.
- **Location:** `src/services/auditLogService.ts:118` (`max: number = 50`) + `limit(max)` at `:124`.
- **Impact:** A heavily-edited entry with >50 corrections would only show the latest 50. Low risk in practice.
- **Recommendation:** Add pagination when the audit viewer UI is built. No action needed now.

### 11. Clock-out reminder / lunch-reminder times hardcoded as fallbacks (18:00 / 15:00)

- **Limitation:** Cloud-function reminder defaults assume a daytime schedule.
- **Location:** `functions/src/reminders.ts:26-28` (`lunch_reminder_time || '15:00'`, `clockout_reminder_time || '18:00'`, `longshift_threshold_hours || 10`).
- **Impact:** Night-shift employees get reminders at the wrong wall-clock time if `systemSettings/reminders` is unset.
- **Recommendation:** Fine as fallbacks; ensure the settings doc is populated per deployment.

### 12. `firestore.rules` enforces no timestamp or daily-count constraints

- **Limitation:** The rules enforce auth, role, immutability of `auditLogs`, and a non-empty `reason` on audit creation — but they impose **no** constraint on time values, shift length, or number of entries per day. All such limits are client-side only.
- **Location:** `firestore.rules:48-71` (timeEntries create/update) — no field validation beyond `userId` match and `isActive()`.
- **Impact:** Any clocked-in client (or a malicious one) can write arbitrary `clockInManual`/`clockOutManual`/`totalWorkMinutes` values, including negative durations or 24h+ shifts. The soft-delete + audit rules are honored, but data-quality limits are not server-enforced.
- **Recommendation:** This is by design for a trust-the-client time tracker, but worth noting. If server-side data quality is required, add rule checks (e.g. `request.resource.data.totalWorkMinutes is int && request.resource.data.totalWorkMinutes >= 0`). Out of scope unless hardening is requested.

---

## Not a limitation (verified safe)

- **`functions/src/seed.ts:71-73`** — the `Math.min(totalMinutes, 8*60)` / `12*60` lines are in a *seed-data generator* that fabricates demo entries; they do not affect production calculations.
- **`Math.floor` in `clockService.getPunchStatus`** (`clockService.ts:297`) — truncates the live "today so far" estimate to whole minutes for display; totals stored on the doc use exact segment minutes. No data loss.
- **`formatMinutesToHHMM`** (`overtimeCalculations.ts`) — display formatting only (replaced the old decimal `formatMinutesToHoursDecimal`); the underlying minute totals are exact.

---

## Priority ranking

| # | Limitation | Severity | Action |
|---|---|---|---|
| 1 | 12h auto-close writes capped/incorrect timestamp, no audit | **High** | Fix (notification-only or route through clockService) |
| ~~9~~ | ~~Conflicting workweek-start defaults (Sun vs Mon)~~ | ~~Medium~~ | ✅ **Resolved (2026-07-18)** — `DEFAULT_WORKWEEK_START_DAY` now Monday; cross-module agreement test added |
| 5 | Hardcoded 08:00–17:00 Mon–Fri schedule | Medium | Per-employee schedule |
| 2 | 8h regular-time threshold (perceived cap) | Low (by design) | UI clarification only |
| 4 | 8h progress-bar target | Low | Cosmetic |
| 6 | Fixed anomaly heuristics | Low | Tie to schedule |
| 10 | 50-row audit cap | Low | Paginate later |
| 11 | Reminder time fallbacks | Low | Set settings doc |
| 12 | No server-side time validation | Informational | Optional hardening |
| 3,7,8 | Correct/expected behavior | None | No action |
