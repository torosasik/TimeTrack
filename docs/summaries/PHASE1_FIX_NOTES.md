# PHASE1_FIX_NOTES.md

**Branch**: fix/phase1-integration-issues
**Based on**: merge/phase1-clock-admin
**Date**: 2026-05-25
**QA Source**: qa/phase1-integration PHASE1_INTEGRATION_QA_REPORT.md

---

## Summary

6 fixes applied. Build: **PASS**. Typecheck: **PASS** (0 errors). Jest: **11/11 pass**.

---

## Fix 1: auditLogService.ts import path

- **File**: `src/services/auditLogService.ts`
- **Change**: `import { db } from '../src/app/lib/firebase'` → `import { db } from '../app/lib/firebase'`
- **Reason**: Wrong relative path — `../src/app/lib/firebase` resolves to a non-existent path from `src/services/`. The correct path is `../app/lib/firebase`. This would crash every audit log write in production, directly breaking the Phase 1 mandatory audit trail requirement.

---

## Fix 2: auditLogs Firestore security rules

- **File**: `firestore.rules`
- **Change**: Added `match /auditLogs/{logId}` block before the closing brace of the outer documents match block.
- **Effect**:
  - `allow read`: admins and managers only
  - `allow create`: admins only, with validation that `reason` is a non-empty string, `targetCollection` is a string, and `occurredAt` is present
  - `allow update, delete`: `if false` — immutable for all roles including admin
- **Reason**: Firestore defaults to deny-all for undefined collections. Without this rule, every `auditLogService.logTimeCorrection()` call (which uses `addDoc`) would be rejected by Firestore in production, silently breaking audit trail durability. This is a Phase 1 blocking security gap.

---

## Fix 3: CorrectionRequests component

- **File created**: `src/app/components/admin/CorrectionRequests.tsx`
- **Props**: `currentUser: User` (matches `App.tsx:278` usage `<CorrectionRequests currentUser={currentUser} />`)
- **Description**: Full working corrections component. Was missing pre-Phase 1 (App.tsx imported it but the file did not exist, blocking the build entirely). Features:
  - Role-aware data loading: admins/managers see all requests via `dbService.getAllCorrectionRequests()`; employees see their own via `dbService.getCorrectionRequestsForUser()`
  - Summary stat cards (admin/manager view)
  - Table listing with employee name, date, issue type, notes, status, submitted date
  - Update dialog for admins: set status (In Progress / Resolved / Rejected) with mandatory resolution note/rejection reason
  - Uses `dbService.updateCorrectionRequest()` for status changes
  - Uses existing shadcn UI components matching AdminPanel.tsx patterns

---

## Fix 4: SectionHelp UI component

- **File created**: `src/app/components/ui/section-help.tsx`
- **Props**: `title: string`, `description?: string`, `sections?: Array<{title, content}>`, `children?: React.ReactNode`
- **Description**: Renders a small `HelpCircle` icon button that opens a Popover with the help content. Used in AdminPanel, AuditViewer, PayrollReports, TeamDashboard, and the new CorrectionRequests. Was missing pre-Phase 1, causing 4+ TypeScript errors across admin and manager components.

---

## Fix 5: dragmeService stub

- **File created**: `src/services/dragmeService.ts`
- **Exports**: `DragmeTask` interface (`id`, `name`, `project?`) and singleton `dragmeService` with methods:
  - `fetchTasks(): Promise<DragmeTask[]>` — returns `[]` when unconfigured
  - `syncEntry(params): Promise<void>` — no-ops when unconfigured
- **Description**: Stub satisfying TodayEntry imports. Matches AGENTS.md policy: all methods silently no-op when `VITE_DRAGME_API_URL` and `VITE_DRAGME_API_KEY` env vars are not set. Does not break any existing TodayEntry functionality (task dropdown shows "No Dragme tasks available", sync is best-effort and caught at call site).

---

## Fix 6: HelpModal component

- **File created**: `src/app/components/ui/help-modal.tsx`
- **Props**: `open: boolean`, `onOpenChange: (open: boolean) => void`, `title: string`, `description?: string`, `children?: React.ReactNode`
- **Description**: Dialog-based help modal used in TodayEntry to surface time-tracking guidance. Wraps shadcn `Dialog` with a header icon, title, description, and a scrollable children body. Matches the usage at `TodayEntry.tsx:1077-1099`.

---

## Post-Fix Checks

| Check | Before Fix | After Fix |
|-------|------------|-----------|
| TypeScript typecheck | FAIL (8 errors) | **PASS** (0 errors) |
| Build | FAIL (unresolved import) | **PASS** (✓ 1744 modules, 19s) |
| Jest tests | 11 pass | **11 pass** (2 suites) |
| Firebase rules test | NOT_AVAILABLE (emulator required) | NOT_AVAILABLE (same constraint) |

---

## Remaining Issues

None — all 6 QA-identified issues are resolved.

---

## Non-Issues (Acceptable — carried from QA report)

- **Employee self-update rule** (`firestore.rules:63-65`): Allows any active authenticated user to update their own time entry, which could theoretically bypass the admin correction audit trail at the DB layer. Classified as a defense-in-depth gap (non-blocking for Phase 1) since app-layer guards enforce admin-only corrections. Recommend splitting the update rule in Phase 2.
- **No lint configuration**: ESLint is not configured in this project. Acceptable for Phase 1.
- **Firebase rules test**: `npm run test:rules` requires a running Firestore emulator. No emulator startup is configured in CI. Firestore rules changes were reviewed manually.
- **ts-jest `esModuleInterop` warning**: Non-fatal Jest warning. Tests still pass.
