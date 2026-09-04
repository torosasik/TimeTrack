# TimeTrack Rule: Timezone Enforcement

**Applies to:** All agents working on time entry, reporting, payroll, or date calculations.

## Mandatory Rule (dual-zone architecture)
- **Employee workflows** — clock in/out, entry doc ids (`${uid}_${date}`), daily/weekly/monthly totals, week boundaries, status banners, work history, and time-adjustment inputs — run in the **employee's local timezone** (`user.timezone`, persisted; falls back to the OS zone). Use helpers in `src/utils/timeCalculations.ts` (`getLocalDate`, `getLocalTimeHHMM`, `getEmployeeTimezone`, `getLocalDateFor`, `subtractLocalDays`) and the local-midnight splitter in `src/utils/midnightSplit.ts`.
- **Admin controls** — payroll math, Lock Payroll Period, Exclude Records From Analysis, and California overtime buckets — run in **`America/Los_Angeles` (PT)** via `src/utils/dateHelpers.js` and `src/utils/overtimeCalculations.ts`.
- Epoch-millis system timestamps (`clockInSystem`/`clockOutSystem`/`lunch*System`) are the single source of truth for instants. Admin/Manager analysis views convert them to the employee's local zone or PT for display via `src/utils/timeView.ts` (the Local/PT view toggle); they never mutate stored values.
- Never use the browser's `Date` object or `new Date()`/`new Date().toISOString()` directly for any value that affects pay or an entry's calendar date. All conversions go through the helpers above (or `Intl.DateTimeFormat` with an explicit `timeZone`).
- Manual `HH:MM` strings are stored in the employee's local wall clock (legacy rows may be PT — display falls back to the stored string when no epoch timestamp exists).

## Verification Checklist (every agent must confirm)
- [ ] Employee-facing date used for entry id, daily total, week boundary, or report is converted via the **local-zone** helpers (`getLocalDate` / `midnightSplit`).
- [ ] Admin payroll control (Lock, Exclude, OT) dates are converted via the **PT** helper (`dateHelpers.js` / `timeView.ts`).
- [ ] No assumption that "today" == server/browser local date or UTC date.
- [ ] Tests that touch dates explicitly set a timezone (local or PT) or use the helper.

**Reference:** AGENTS.md (Timezone Architecture), `src/utils/timeCalculations.ts`, `src/utils/midnightSplit.ts`, `src/utils/timeView.ts`, `src/utils/dateHelpers.js`
