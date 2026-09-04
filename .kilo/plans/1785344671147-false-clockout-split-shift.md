# Bug: "Didn't clock out but looks clocked out" — split-shift false completion

**Affected entry:** `QYGynGi7DhZGnmkrDwMYDbfrjbv1_2026-07-28` (Firestore `timeEntries` doc; data not in repo — analysis is code-path based).

## Symptom
User started a 2nd shift on the 07-28 doc (intended as "next day", but PT still = 07-28) and never clocked it out. Yet every view shows them as **clocked out / complete** with a **daily total of exactly 10h** and no "Missing Clock Out" warning.

## Root cause
`mapEntry` in `src/app/lib/database.ts:239-245` — the **S1 dual-write-divergence fallback**.

```ts
const lastPersistedSeg = archived.length ? archived[archived.length - 1] : null;
if (lastPersistedSeg) {
  if (!entry.clockInManual && lastPersistedSeg.clockInManual) entry.clockInManual = lastPersistedSeg.clockInManual;
  if (!entry.clockOutManual && lastPersistedSeg.clockOutManual) entry.clockOutManual = lastPersistedSeg.clockOutManual;   // <-- poisons
  if (!entry.lunchOutManual && lastPersistedSeg.lunchOutManual) entry.lunchOutManual = lastPersistedSeg.lunchOutManual; // <-- poisons
  if (!entry.lunchInManual && lastPersistedSeg.lunchInManual) entry.lunchInManual = lastPersistedSeg.lunchInManual;     // <-- poisons
}
```

The fallback was written to repair a doc whose **same** shift is persisted in `segments[]` but whose top-level `clockOutManual` wasn't dual-written. It does **not** check whether the top-level fields actually belong to that same shift. When the doc has:

- `segments[]` = `[seg1(complete, clockIn=A, clockOut=B, workMinutes=600)]`, and
- top-level fields = a **newer, open** shift `seg2` (`clockInManual=C`, `clockOutManual=''` → `undefined`, `complete=false`),

the fallback copies seg1's `clockOutManual=B` up to `entry.clockOutManual`. Consequences in `mapEntry`:
- `current` synthesized segment becomes `{ clockInManual: C, clockOutManual: B, complete: true, workMinutes: deriveSegmentWorkMinutes(C, B, ...) }`.
- Because seg2's PT clock-in `C` is **later** than seg1's clock-out `B`, `deriveSegmentWorkMinutes` (`outM - inM` with no cross-midnight wrap, clamped `≥ 0`) returns **0**.
- Day total override (`archived.length > 0`) → `archivedMins(600) + currentMins(0) = 600` = **exactly 10h** (= seg1's real minutes; the spurious current contributes exactly 0).
- `entry.clockOutManual` is now non-null and `current.complete = true`, so `getActiveSegment` returns `null` → ClockPunch shows **CLOCKED OUT**, ClockStatus shows "CLOCKED OUT", and HistoryView's `hasWarning = boundaries.isOpen || !entry.clockOutManual` is `false` → renders a clean, complete 10h day with **no** "Missing Clock Out" and the open seg2 is not even shown as a sub-row (HistoryView only iterates `entry.segments`, where seg2 is absent).

## Trigger path (which writer leaves the doc in this shape)
- `clockService.punchIn` (the **default** ClockPunch UI per `App.tsx`) **appends** the new open seg2 into `segments[]`, so `segments[]` ends in an open segment → the S1 fallback does **not** fire → user is correctly shown clocked-in. So the pure-ClockPunch path does **not** reproduce the bug.
- `TodayEntry` ("classic" UI, `?classic=1`) `submitClockIn` **split-shift** branch (`TodayEntry.tsx:269-336`) archives seg1 into `segments[]` via `arrayUnion` and writes the open seg2 **only** into top-level fields with `clockOutManual: ''`. `segments[]` therefore ends in the **closed** seg1 → the S1 fallback fires → false clock-out. **This is the reproducing path.**

> ⚠ Assumption: the affected user reached this doc shape via the TodayEntry classic split-shift path (or an equivalent legacy/partial write). Because the data is in Firestore and not in the repo, **Step 0 below confirms the actual doc** before any write-side/backfill work. The **read-side fix is correct and safe regardless of which writer created the shape**, so it can proceed independent of that confirmation.

## Answers to the operator's specific questions
1. **Investigate the data:** done via code-path trace (data is in Firestore, not in repo).
2. **Timezone / 2nd-shift effect:** The TZ difference (user ahead of PT) is what routed the "next day" punch onto the 07-28 PT doc as a 2nd shift — the **precondition** for the split-shift path. It does not itself cause the false clock-out, but the specific PT-time ordering (seg2 clock-in later than seg1 clock-out) is why the false total lands *cleanly* on seg1's exact minutes (10h). If the PT times were ordered differently the bug would still show a false clock-out, just with a non-10h total.
3. **10h hard cap:** **None exists.** The only "10" is the *longshift reminder* threshold (`functions/src/reminders.ts:37`, default 10h, configurable via `longshift_threshold_hours`) — notification-only (email/SMS + `longshift_reminder_sent_at`); it never writes `clockOutManual`/`complete`/`dayComplete`. The only shift-*closing* cap is the TodayEntry **12h** watchdog (`MAX_SHIFT_HOURS = 12`, `TodayEntry.tsx:78`, client-side, fires only while TodayEntry is mounted). The 10h is seg1's genuine worked minutes (600) surfacing as the day total; the false current segment adds 0 via the clamp.
4. **Cause + solution:** cause = the unguarded S1 fallback (above). Solution = guard it (read-side) + make TodayEntry's split-shift writer consistent (write-side) + optional backfill. Below.

## Guardrail check
- **Timezone (AGENTS.md §2):** fix is in `mapEntry` (hydration), no new date math; no `Date`/`new Date()` introduced.
- **Soft-delete (`.kilo/rules/soft-delete-and-segments.md`):** no `.delete()`; segment model preserved (we keep seg2 as an open segment).
- **Mandatory audit (`.kilo/rules/audit-mandatory-reason.md`):** the read-side fix mutates **no** time data (read-only hydration) → no audit needed. The write-side fix and any backfill mutate time data → **must** write `auditLogs` first with a non-empty reason.
- **CA OT:** unchanged; totals are derived from `workMinutes` as before.

## Plan

### Step 0 — Confirm actual doc (diagnostic, no code change)
Read the raw Firestore doc `QYGynGi7DhZGnmkrDwMYDbfrjbv1_2026-07-28` and verify:
- `segments[]` ends in a **complete** segment (seg1) with a `clockOutManual`;
- top-level `clockOutManual` is empty/`''`/null and `clockInManual` belongs to a **different** (later) shift than seg1;
- `dayComplete`/`complete` is false (else a different root cause applies).
This confirms the reproducing shape and whether the user was on `?classic=1` (TodayEntry) vs ClockPunch. Determines whether the write-side fix + backfill are needed beyond the read-side guard.

### Step 1 — Fix `mapEntry` S1 fallback (read-side, primary) — `src/app/lib/database.ts:239-245`
Only inherit the last persisted segment's `clockOutManual`/`lunchOutManual`/`lunchInManual` when the top-level fields plausibly belong to the **same** shift. Replace the block with:

```ts
const lastPersistedSeg = archived.length ? archived[archived.length - 1] : null;
if (lastPersistedSeg) {
  if (!entry.clockInManual && lastPersistedSeg.clockInManual) entry.clockInManual = lastPersistedSeg.clockInManual;
  // Only inherit clock-out/lunch from the last persisted segment when the
  // top-level clockIn is absent (legacy doc) OR matches that segment's
  // clockIn (same shift, dual-write divergence). If the top-level clockIn
  // belongs to a DIFFERENT (newer, open) shift, the persisted segment is a
  // prior CLOSED shift and its clock-out/lunch must NOT be inherited —
  // doing so falsely marks the open shift complete ("looks clocked out").
  const sameShift =
    !entry.clockInManual || entry.clockInManual === lastPersistedSeg.clockInManual;
  if (sameShift) {
    if (!entry.clockOutManual && lastPersistedSeg.clockOutManual) entry.clockOutManual = lastPersistedSeg.clockOutManual;
    if (!entry.lunchOutManual && lastPersistedSeg.lunchOutManual) entry.lunchOutManual = lastPersistedSeg.lunchOutManual;
    if (!entry.lunchInManual && lastPersistedSeg.lunchInManual) entry.lunchInManual = lastPersistedSeg.lunchInManual;
  }
}
```

Effect: with the guard, seg2 stays open (`clockOutManual` undefined → `current.complete = false` → `getActiveSegment` returns seg2 → ClockPunch shows CLOCKED OUT button / clocked-IN; HistoryView shows seg2 with "—" + "Missing Clock Out"; day total = seg1 minutes + live open-segment estimate, no false 10h-as-complete). Fixes **all** readers for affected docs with zero writes.

### Step 2 — Fix TodayEntry split-shift writer (write-side) — `src/app/components/employee/TodayEntry.tsx:269-336`
Make the "Start New Shift" (`submitClockIn` complete-branch) push the new **open** seg2 into `segments[]` (consistent with `clockService.punchIn`), so the persisted shape never ends in a closed segment while an open shift lives only in top-level fields. Mirror `clockService.punchIn`'s payload: `segments: [...existingSegments, stripUndefined(createInitialSegment(currentTime, now.toMillis(), taskId))]`, keep `clockOutManual: ''`, `dayComplete:false`, `complete:false`, `totalWorkMinutes: accumulatedMinutes`. (Audit: this is the employee's own new punch-in, not a correction to historical data — no audit-log entry required for a fresh open segment; the mandatory-audit rule applies to *corrections* of existing time data, which this is not. Confirm with reviewer/payroll-guardian.)

### Step 3 — Backfill already-affected docs (optional, deferred; read-side fix already corrects views)
Only if Step 0 finds genuinely broken docs. Normalize: move the open seg2 into `segments[]`, clear the false top-level `clockOutManual`. **Must** write `auditLogs` first (actor 'system' or 'admin', non-empty reason e.g. "Repair split-shift doc whose open segment was falsely rendered as complete (S1 fallback bug)") and never hard-delete. Because Step 1 already renders these docs correctly, this is non-urgent and can be a small scoped script.

## Tests to add / update
- `src/app/lib/database.test.ts`: add a case — doc with `segments:[seg1(complete, clockOut=B, workMinutes=600)]` + top-level `clockInManual=C` (≠A), `clockOutManual=''`, `dayComplete:false` → assert `mapEntry` yields `clockOutManual === undefined`, `currentSegment.complete === false`, `getActiveSegment(entry) !== null` (open), and `totalWorkMinutes === 600` with the open seg2 visible (not falsely complete). Also assert the legit dual-write case still inherits (top-level `clockInManual` absent or matching seg1 → `clockOutManual === B`).
- Regression: a pure-ClockPunch two-segment doc (seg1 complete + seg2 open both in `segments[]`) must still show clocked-in (unchanged behavior) — guard against the guard.
- `src/utils/overtimeCalculations.test.ts` already covers 600-min daily OT; no change.

## Validation
```
npm run lint
npm run test
npm run test:rules   # only if firestore.rules touched (not expected here)
```
Manual: in `?classic=1`, complete a shift, "Start New Shift", do not clock out → ClockPunch/TodayEntry/HistoryView must show clocked-IN + "Missing Clock Out" + open seg2 (not "complete 10h"). In default ClockPunch, two punches on same PT day → same correct open state (regression).

## Out of scope (flagged, separate tasks)
- `TodayEntry` uses `today = new Date().toISOString().split('T')[0]` (UTC) for the doc id + 12h watchdog (`TodayEntry.tsx:92,164`) — not PT; latent TZ hazard (AGENTS.md §2) and part of why the "next day" punch landed on 07-28. Align to `getCurrentPTDate()`.
- TodayEntry 12h watchdog writes an auto-close with capped timestamps and **no audit log** (violates `.kilo/rules/audit-mandatory-reason.md`); ClockPunch's 16h watchdog is notification-only by design. Reconcile.
