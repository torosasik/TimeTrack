# TimeTrack Rule: Mandatory Audit Reason on Every Correction

**Applies to:** Any change that modifies historical time data (corrections, admin edits, bulk imports, etc.).

## Mandatory Rule
- Every correction to a time record **MUST** produce an immutable entry in the `auditLogs` collection.
- **Employee self-edits** (≤24h Quick Edit path): The correction **MUST** include a non-empty, human-provided `reason`.
- **Admin/manager-initiated corrections**: The `reason` field is **OPTIONAL** (policy change 2026-08). The immutable audit row is still written, but it may have an empty reason.
- No path may bypass the audit log entry creation (including future admin UIs, import scripts, or direct Firestore writes in tests).

## Verification Checklist
- [ ] The correction flow writes to `auditLogs` with the exact reason supplied by the user (when provided).
- [ ] Employee self-edits without a reason are rejected (UI + service + Firestore rules).
- [ ] Admin edits without a reason are allowed and still produce an audit log entry.
- [ ] There is no "silent correction" or "adminNotes only" path that skips the audit log.
- [ ] Tests cover the audit entry creation for both employee and admin paths.

**Reference:** AGENTS.md line 37 ("Audit Requirement")
