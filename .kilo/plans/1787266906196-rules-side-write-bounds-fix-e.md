# Future Option — Audit Fix E: Rules-Side Write Bounds for Employee Self-Edits

**Status:** DEFERRED (not implemented — recorded 2026-08-21 for later consideration)
**Origin:** Time-adjustment validation audit (2026-08-18), finding #7 + recommended fix E; deferred by project owner after discussion.
**Priority when resumed:** Medium. It is the only recommended hardening from the audit still unimplemented, and the only defense against a crafted client (all other guardrails live in bypassable app code).

---

## 1. Problem Statement

`firestore.rules` currently allow any authenticated employee to update their own
`timeEntries` docs with no constraint on WHAT changes:

```
allow update: if isSignedIn() && (request.auth.uid == resource.data.userId || hasRole('admin'));
```

Every write guardrail built in the app (chronology, future-time rejection, the
≤24h edit window, overlap, payroll lock) lives in client-side JavaScript
(`src/utils/timeValidation.ts`, `src/app/lib/database.ts` handlers). A
technically capable employee can reuse their own browser auth token with the
Firebase SDK directly and write ANY span: fabricated shifts, backdated
clock-ins, doctored `totalWorkMinutes`. Rules are evaluated server-side and
cannot be bypassed by a crafted client — they are the only enforcement layer
with that property.

## 2. Proposed Solution (Bounding Box, Not Proof of Correctness)

Rules have access to `request.time` (server receive time), `resource.data`
(existing doc), and `request.resource.data` (incoming doc), plus arithmetic on
those. That enables four enforceable bounds on EMPLOYEE self-writes (admins
stay unrestricted via the existing `hasRole('admin')` branch, so Correct Entry
and the Repair Runaway Shifts tool are unaffected):

### 2a. No-future rule (highest value)
Reject any self-write where `clockInSystem` / `clockOutSystem` (and segment
`*System` fields) exceed `request.time.toMillis()`. Fabricating FUTURE shifts
becomes impossible at the API level.

### 2b. 24h recency window
On employee updates, require the shift's `clockInSystem` to be within ~24h of
`request.time` — mirroring the TimeAdjustmentModal's currently UI-only window:

```
// conceptual shape, not final syntax
request.time.toMillis() - resource.data.clockInSystem <= 86400000
```

This stops after-hours rewriting of last week's / last month's entries.

### 2c. Max-span sanity bound
Reject self-writes where `clockOutSystem - clockInSystem` exceeds a chosen
ceiling (suggest 18h, or 24h to be conservative — note on-site night-shift
clock-ins after 22:00 can legitimately run ~22.5h under the next-day-10PM cap,
so 24h is the safe choice). Kills multi-day fabricated spans outright without
needing chronology math.

### 2d. Field allow-list
Restrict WHICH fields employees may self-modify (punch manuals, `*System`
epochs, `segments`, completion flags as used by clockService) and forbid
direct self-writes of `totalWorkMinutes`, `totalHours`, `status`, `flagged`,
`autoClosed`, `workWeekStartDate`, `overtime*`. The read-side SSOT
(`getEntryTotals`) recomputes totals from punches anyway, so bounding punch
edits bounds the payroll damage.

## 3. What Rules Still CANNOT Do (accept these gaps)

- No cross-document queries → no overlap detection against sibling days.
- No timezone math → no local-10PM cap enforcement.
- No deep array-field chronology → segment-internal lunch ordering stays app-side.
- No multi-document constraints → cannot REQUIRE a companion auditLogs write
  (the audit rule stays an application-layer invariant).
- Rules bound the fabrication space to "plausible recent shift" — they do not
  prove a write is correct.

## 4. Implementation Risks / Required Legit-Path Validation

Every new constraint will also be hit by LEGITIMATE write paths. Before
deploying, verify each against the bounds:

1. `clockService.punchIn/punchOut/toggleLunch` transactions (dual-write of
   millis + Firestore Timestamp fields — allow-list must include both).
2. **Midnight-split punch-out path** (clockService.ts ~330): creates day-2+
   docs whose `clockInSystem` is exactly local midnight — inside the 24h
   window, but confirm under clock skew / DST transitions (spring-forward
   23h day, fall-back 25h day — use 26h for the recency window if nervous).
3. Cron `runAutoGuardrails` writes via Admin SDK — bypasses rules entirely,
   unaffected.
4. Repair utility + admin Correct Entry — run as admin role, unaffected.
5. Legacy flat-doc writes from TodayEntry (still rendered when
   useClassicEntry is set) — `clockInSystemTime`-only shape must satisfy any
   field-presence requirements.
6. Employee edit paths (directEditSegmentField / directCloseShift /
   directEndLunch) already enforce the same bounds app-side — rules should
   match them exactly to avoid "UI allows, rules reject" dead ends.

## 5. Rollout Plan (when resumed)

1. Write the rule changes in `firestore.rules` behind a single helper function
   (e.g. `isBoundedSelfTimeWrite()`), keeping the admin branch first.
2. Extend `tests/rules/` (npm run test:rules) with:
   - Attack cases: future punch, >24h-old edit, >24h span, direct
     totalWorkMinutes write → all must FAIL for employees, PASS for admins.
   - Legit cases: punch in/out, lunch toggle, midnight-split day-2 doc
     creation, directEdit/directClose/directEndLunch payloads → must PASS.
3. Deploy rules only: `firebase deploy --only firestore:rules`.
4. Monitor for rejected-write toasts in the first days (ClockPunch surfaces
   them via the write-failure banner).

## 6. Current State Without Fix E (accepted risk)

- Open shifts are hard-capped by the deployed `runAutoGuardrails` cron
  (on-site 10 PM local / remote 12h / lunch 1h, transactional + audit-first).
- App-UI edits are fully guarded (chronology/future/overlap/lock).
- Residual exposure: a crafted API client can still fabricate a plausible
  self-entry. Every write that DOES happen through the app is audited; a
  crafted write would NOT produce an auditLogs row, which itself is a
  detection signal (entries with status 'corrected' but no matching audit row
  = suspicious). A periodic audit-vs-entry reconciliation report could be a
  cheaper intermediate step before implementing Fix E.

## 7. References

- Audit report: conversation 2026-08-18 (Time-Adjustment Validation Audit,
  missing guardrail #7 + recommended fix E).
- Rules file: `firestore.rules` (timeEntries match block ~line 63-80).
- Self-edit service paths: `src/app/lib/database.ts` (directEditSegmentField,
  directCloseShift, directEndLunch) — their guardrail blocks show the exact
  bounds to mirror.
- App-side validators: `src/utils/timeValidation.ts`
  (validateSegmentChronology, getFuturePunchError, getSegmentOverlapError).
- Rules tests: `npm run test:rules` (tests/rules/).