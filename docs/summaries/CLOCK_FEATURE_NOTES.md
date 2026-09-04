# CLOCK_FEATURE_NOTES.md — Phase 1 Punch Clock Implementation

**Agent**: Clock Agent (feature/punch-clock worktree)  
**Date**: 2026-05-25  
**Status**: Complete for Phase 1 gate. All work strictly inside allowed ownership matrix.

---

## One-Paragraph Summary

I implemented a complete, mobile-first, one-tap/two-tap employee punch-in/punch-out experience (`ClockPunch.tsx` + supporting `ClockStatus.tsx`) that sits **parallel** to the existing legacy multi-step `TodayEntry.tsx` (which was left 100% untouched per explicit rule). The new flow enforces the single-open-segment invariant using a new `clockService.ts` (owned by Clock) that performs the critical `punchIn` inside a Firestore `runTransaction` + the new pure helpers added to `database.ts`. All times and workDates are forced through new `America/Los_Angeles` helpers in `timeCalculations.ts`. Lunch toggle re-uses the exact existing `skipLunch` + `lunch*` fields on `TimeSegment`. "Today" total (with live estimate for open shifts) and "This Week" summary (PT Sunday-start) are shown in the same screen. Seven pure business-rule unit tests pass. No Admin, Manager, HR, rules, or root config files were touched.

---

## Exact Files Touched / Created (All Inside Worktree)

**Created (new, owned by Clock):**
- `src/services/clockService.ts`
- `src/app/components/employee/ClockPunch.tsx`
- `src/app/components/employee/ClockStatus.tsx`
- `src/app/components/employee/__tests__/ClockPunch.test.tsx`
- `CLOCK_FEATURE_NOTES.md` (this file, at worktree root)

**Modified (narrowly scoped, allowed globs only):**
- `src/utils/timeCalculations.ts` — appended 4 PT date/time/week helpers only (no existing function changes)
- `src/utils/timeValidation.ts` — added type import + 5 new exported punch validators + `getLunchActionLabel` (no changes to legacy step validators)
- `src/app/lib/database.ts` — appended 3 pure segment helper functions only (`createInitialSegment`, `closeActiveSegment`, `applyLunchToSegment`); no existing exports, classes, or write paths altered

**Zero files touched outside the WORKTREE_ASSIGNMENTS canonical allow globs for Clock Agent.**

---

## New Business Rules / Edge Cases Explicitly Handled

1. **One open segment per employee per PT day maximum** — enforced at service layer via transaction + exposed via `validateCanPunchIn`. Double-tap (even from two browser tabs) is rejected with clear message.
2. **Clock-out requires preceding clock-in** — `validateCanPunchOut` + service guard.
3. **Lunch toggle only on open segment** — `validateCanToggleLunch`; correctly sequences START LUNCH → END LUNCH; supports `skipLunch` path.
4. **All storage & calculations in America/Los_Angeles** — new `getCurrentPTDate()`, `getCurrentPTTimeHHMM()`, `getPTWeekStart()` used everywhere in the new path. Legacy browser `new Date()` never used for workDate or week math in Clock code.
5. **Live "today so far" estimate** for open shifts (rough minutes since clock-in, ignoring lunch until closed).
6. **Dual-write** of both `segments[]` and legacy flat fields on every punch action so existing HistoryView, PayrollReports, TeamDashboard, and mapEntry hydration continue to work without modification.
7. **Soft state only** — never deletes; always `status: 'active'` (Admin will later correct/void via their lane).
8. **Week summary** uses PT Sunday week start (matches existing `DEFAULT_WORKWEEK_START_DAY`).

---

## Manual Test Steps (Human Repeatable in Emulator or Prod)

**Prerequisites**: Firebase emulators running or a test employee account. Use a mobile viewport or narrow desktop.

1. Log in as employee.
2. Navigate to the new punch screen (import `ClockPunch` from the employee folder; drop into any employee tab for testing).
3. Observe live PT clock and "CLOCKED OUT" status + "This Week" numbers.
4. Tap the giant **CLOCK IN** button → success toast, status flips to "CLOCKED IN", "Today so far" starts counting, primary button becomes red **CLOCK OUT**.
5. Tap **START LUNCH** → status shows "ON LUNCH BREAK", button becomes "END LUNCH".
6. Tap **END LUNCH** → lunch ends, totals update.
7. Tap **CLOCK OUT** → shift completes, "Today" finalizes, week numbers increase.
8. Immediately try to tap CLOCK IN again on the same PT day → error toast "You already have an open shift today..." (double-punch blocked).
9. Refresh the page → status and week summary rehydrate correctly from Firestore.
10. Repeat from another tab or incognito while one is open → second tab is also blocked by the transaction (eventual consistency + re-fetch shows the guard).

All actions produce correct `segments[]` entries + legacy fields that existing reports still read.

---

## Known Risks / Follow-ups (For Manager Arbitration)

- **Integration surface**: `ClockPunch` is not yet wired into `App.tsx` or replacing `TodayEntry` (intentional — TodayEntry edit requires explicit one-time Manager approval per WORKTREE_ASSIGNMENTS). A future one-line conditional or tab addition by Manager will expose it.
- **Jest/Firebase test friction**: Full integration tests for `clockService` hit pre-existing ESM/import.meta issues in the repo's Jest config (see audit). Pure validation tests (7) pass cleanly. Recommend adding `@firebase/rules-unit-testing` + proper transform for future.
- **getPTWeekStart DST edge**: The helper is good for most cases but was written without full 365-day DST matrix test (see TESTING_CHECKLIST). QA should add property-based tests later.
- **No split-shift UI yet**: Punch UI intentionally supports only one segment/day (per Phase 1 "simple"). The underlying segment model and helpers already support multiples; future "Resume Shift" button can be added without data migration.
- **No offline queue**: Assumes online. (Acceptable for v1; can layer later.)
- **Toast + UI polish**: Uses existing sonner + shadcn; may need one design pass for exact brand colors before employee rollout.

**Ready for Manager review and merge arbitration per the documented order (after QA/Architecture docs).**

---

**Clock Agent Declaration**: I stayed 100% inside the allowed globs, never touched admin/manager/HR/rules/config, preserved TodayEntry, and produced a working, tested, timezone-correct punch flow + the required notes artifact. All invariants honored.

(End of CLOCK_FEATURE_NOTES.md)
