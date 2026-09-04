# FIRESTORE_DATA_MODEL.md — Canonical Collections, States & Evolution (First-Run Design)

**Agent**: Architecture Agent  
**Worktree**: architecture/hr-time-structure  
**Status (First Run)**: Pure design. No collections, indexes, rules, or source files were created or changed in the working repository.

---

## 1. Design Philosophy
- Evolve the existing high-quality split-segment model instead of replacement.
- Every business change to time records produces an immutable `auditLogs` row (mandatory].
- Soft state everywhere: no destructive deletes after initial creation.
- America/Los_Angeles is the single source-of-truth timezone for all payroll-relevant fields (`workedDate`, segment event instants in millis or ISO with offset stored for safety).
- Phase 1 scope = clock + corrections with audit trail. Phase 2 adds leave/holidays/policy without mutating Phase 1 shapes.
- Document is the contract between Architecture, Clock, Admin, and HR agents post-gate.

---

## 2. Versioning & Migration Strategy
- Collection-level "v" tags avoided; instead additive fields + deprecated legacy flat fields preserved for 6–12 months.
- Dual-write period will exist during the first punch-clock migration.
- Any agent proposing a breaking change must update this document first and obtain Manager + Architecture sign-off.

---

## 3. Collection Catalog (v1.5 → Phase 2 Target)

### 3.1 users (Unchanged Core, Added Profile Fields)
```
users/{uid}
  uid: string (== doc id)
  email: string
  name: string
  role: "employee" | "manager" | "admin"
  active: boolean (default true)
  createdAt: Timestamp
  createdBy: string (uid)
  updatedAt?: Timestamp

  // Current optional profile fields (already present)
  work_email?: string
  phone_number?: string
  sms_opt_in?: boolean
  timezone?: string (IANA; display preference only — does not affect payroll math)
  remotePayCalculationDay?: number  // integer 1–28; pay-calc anchor day for Remote employees; written as 1 on user creation, backfilled to 1 on all existing docs (admin-init migration); editable for Remote users via User Base → Edit User (visible only when workModel == "Remote"; omitted from the write payload for non-Remote users so the stored value survives work-model toggles)

  // Phase 2 additions (leave planning)
  department?: string
  employee_number?: string
  hire_date?: string (YYYY-MM-DD, PT logical)
  employment_type?: "full_time" | "part_time" | "seasonal"
  policy_id?: string  // references workPolicies
  manager_uid?: string
```

Indexes: none additional needed beyond current (auth-driven reads).

### 3.2 timeEntries (Primary Attendance Record)
**Doc ID pattern**: `{userId}_{YYYY-MM-DD}` (stable, sortable).

```
timeEntries/{uid}_{date}
  // Identity & Partitioning
  id: string
  userId: string
  workDate: string (YYYY-MM-DD in America/Los_Angeles)
  status: "active" | "corrected" | "voided" | "archived"
  createdAt: Timestamp
  createdBy: string (uid or "system" on import)

  // Legacy flat fields (kept during transition; populated from first segment for backward UI)
  clockInManual, clockOutManual, lunchOutManual, lunchInManual?: string (HH:MM)
  skipLunch?: boolean
  clockInSystem, ...System?: number (millis since epoch in PT)
  totalWorkMinutes?: number
  regularMinutes, otMinutes, doubleTimeMinutes?: number
  totalHours, regularHours, overtimeHours, doubleTimeHours?: number
  flags?: string[]
  adminNotes?: string          // legacy free-text
  correctionRequested?: boolean
  anomalyFlag?: boolean
  completedAt?: number
  lunch_reminder_sent_at, etc.

  // Modern segment model (already shipping)
  segments?: TimeSegment[]

  // New Phase 1 fields
  lastCorrectedAt?: Timestamp
  correctionCount?: number
  timezoneAtCreation: "America/Los_Angeles"   // explicit marker

  // Phase 2 (leave linkage)
  leaveHoursDeducted?: number   // populated by HR leave workflow
  holidayHoursIncluded?: number
```

**TimeSegment** (embedded):
```
{
  id: string (stable),
  clockInManual?: string, clockInSystem?: number,
  lunchOutManual?, lunchOutSystem?,
  lunchInManual?, lunchInSystem?,
  clockOutManual?, clockOutSystem?,
  skipLunch?: boolean,
  workMinutes?: number,
  complete: boolean,
  taskId?: string,                  // optional external
  autoClosed?: boolean,
  status?: "active" | "corrected"   // per-segment future
}
```

**Important Invariants**:
- At most one segment may be incomplete at a time per employee.
- `workDate` is the **logical attendance day** in company time. Segments that cross midnight stay on the clock-in day by policy.

**Indexes** (current + future):
- Existing: `(userId ASC, workDate DESC)`
- New recommendation: `(status ASC, workDate DESC)` for admin "needs review" queries.
- `(userId ASC, status ASC, workDate DESC)` — employee personal history with filter.

### 3.3 auditLogs (NEW — Phase 1 Non-Negotiable)
Immutable append-only collection. Never updated/deleted except by administrative purge (rare, audited).

```
auditLogs/{autoId}
  id: string
  occurredAt: Timestamp
  actorUid: string
  actorName?: string
  actorRole: "admin" | "system"
  action: "time_correction" | "void_entry" | "leave_approval" | ...
  targetCollection: "timeEntries"
  targetId: string           // timeEntries doc id

  // Before/After snapshots (full relevant subset)
  before: {...}              // prior segment(s), status, hours
  after: {...}

  reason: string (required, non-empty, user-entered + system notes)
  ip?: string                // optional for future
  userAgent?: string

  // Linkage
  correctionRequestId?: string   // if triggered from employee request
  policyVersion?: string
```

FireStore composite index suggestion:
`(targetCollection ASC, targetId ASC, occurredAt DESC)`

This structure guarantees reconstructability of any employee day from audit trail alone.

### 3.4 correctionRequests (Evolved)
Existing shape is acceptable. Minor additions for Phase 1 clean-up:

```
correctionRequests/{autoId}
  ...
  status: "Open" | "In_Progress" | "Resolved" | "Rejected"
  resolution_note: string (optional)
  resolved_by?: string
  resolved_at?: Timestamp
  audit_log_id?: string   // the resulting auditLogs row
```

Future: Add `original_entry_snapshot` JSON blob at creation time to freeze state for the employee view.

### 3.5 systemSettings (Minimalist Singleton Docs)
Current `payroll` doc remains the only known child:

```
systemSettings/payroll
  locked_up_to_date: "YYYY-MM-DD"
  locked_at
  locked_by
```

Future children (Phase 2+): `holiday_defaults`, `leave_accrual_rules`, `export_format_versions`.

Rules already allow all authenticated read on payroll (for lock awareness).

### 3.6 Phase 2 HR Collections (Read-Only for Phase 1 Agents)

**leaveRequests**
```
leaveRequests/{id}
  employeeUid, requestedBy
  leaveType: "vacation" | "sick" | "unpaid" | "bereavement" ...
  startDate, endDate (YYYY-MM-DD PT)
  durationMinutes, durationDays
  status: "requested" | "approved" | "rejected" | "cancelled"
  approverUid?, decisionAt?, decisionNote?
  relatedAuditLogIds: string[]
  createdAt
```

**vacationBalances** (overridable summary)
```
vacationBalances/{employeeUid}
  accruedMinutes: number
  usedMinutes: number
  carriedOverMinutes?: number
  asOfDate: string
  policyId: string
  updatedAt
```

**holidays**
```
holidays/{YYYY-MM-DD}_us_ca
  date: "YYYY-MM-DD"
  name: string
  type: "federal" | "state_ca" | "company"
  observedRule?: "nearest_weekday" | "none"
  locations?: string[]
  active: boolean
```

**workPolicies**
```
workPolicies/{policyId}
  name
  defaultWorkweekStartDay: 0-6 (0=Sunday)
  expectedWeeklyMinutes: number
  overtimeRules: { daily_1_5x, daily_2x, weekly_40h, ... }
  leaveAccrual: { vacation_per_hour_worked, sick_cap, ... }
  effectiveFrom: Timestamp
  supersedes?: string[]
```

---

## 4. Query Patterns Established

- Employee punch history: `where userId, workDate >= start, order workDate desc`
- Admin daily snapshot (who is clocked in): Query active + **open segment** via client reconstruction from last segment (no server streaming needed initially).
- Payroll biweekly: Query by workDate range + status != voided.
- Corrections: `correctionRequests` + join to `auditLogs` for full provenance.
- Leave calendar: Mostly HR pending approval queries + pre-computed holidays.

Avoid large collection scans; indexes designed above suffice for initial 200–2000 employee scale.

---

## 5. Soft-Delete & Archival Lifecycle
- `status` transitions:
  - active → corrected (normal)
  - corrected → voided (rare, audit required)
  - active/voided → archived (7+ year retention purge candidate)
- Never remove the Firestore document. Use expiration label + periodic export to cold storage.

---

## 6. First-Run Compatibility Notes

**Current production documents** (legacy flat fields + segments array) will continue to hydrate under the new `status` field defaulting to `"active"` on read.

Migration step (post-Architecture, by Clock or Admin helper):
- Backfill `status: "active"` + `timezoneAtCreation` on all existing timeEntries lacking the fields.

No downtime required.

---

## 7. Future Index Additions (Document Only)

Will be added to `firestore.indexes.json` only after:
- Architecture review complete
- QA has validated the rule surface
- Manager explicit approval ticket

---

**Architecture Agent Sign-off (Planning Phase)**: This schema reflects ground truth from the Audit Agent project reconnaissance plus business requirements stated in the master prompt. Zero mutations performed on live `firestore.*` assets.

Next step for this agent: Produce SECURITY_RULES_PLAN.md (following document).
