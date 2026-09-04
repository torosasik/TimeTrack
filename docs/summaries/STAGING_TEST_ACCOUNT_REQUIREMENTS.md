# Staging Test Account Requirements

**Date:** 2026-05-25  
**Related:** STAGING_DEPLOY_BLOCKER_REPORT.md  
**Purpose:** Document exactly what test accounts are needed to perform runtime validation on a future staging environment. No credentials are invented or hardcoded.

---

## Why Test Accounts Are Required

Runtime validation of the employee clock-in/out flows, admin correction flows, audit log creation, and role-based access cannot be performed in this environment because:

- No staging Firebase project is configured or accessible.
- No `firebase login` has been performed.
- No test users exist in any environment accessible from this workspace.
- The local emulator (`VITE_USE_EMULATORS=true`) can run the app shell but does not provide realistic auth/role simulation for full end-to-end flows (especially admin vs employee permissions and Firestore rules enforcement).
- Seeding for **real staging projects** requires separate handling (see "Local Emulator vs Real Staging Seeding" section below). `npm run seed:test-users` is emulator-only and does **not** require or use `firebase login` to a real project.

Per instructions: "If runtime validation requires test accounts and none exist: Create STAGING_TEST_ACCOUNT_REQUIREMENTS.md. Document required test accounts. Do not invent or hardcode credentials."

---

## Required Test Accounts (Minimum for Validation)

To execute the validation checklist in STAGING_DEPLOYMENT_AND_VALIDATION_REPORT.md, the following distinct accounts must exist in the **staging Firebase project** (with corresponding entries in the `users` collection and proper `role` + `active` fields):

### 1. Employee Test Account (Primary Clock Flow Tester)
- **Email:** (owner to provide, e.g., `employee-test@staging.example`)
- **Password:** (owner to provide / reset via Firebase Auth)
- **Firestore `/users/{uid}` document fields (minimum):**
  - `uid`: (matches Auth UID)
  - `email`: matches above
  - `name`: "Test Employee"
  - `role`: "employee"
  - `active`: true
  - `timezone`: "America/Los_Angeles" (or omit to default)
- **Purpose:**
  - Verify login screen
  - Employee dashboard / TodayEntry / ClockPunch loads
  - Clock in (creates time entry with status active)
  - Double clock-in blocked (validation)
  - Lunch toggle (out/in/skip)
  - Clock out
  - Clock out without active session blocked
  - Void/reset in test mode (if exposed)
  - Layout at phone width (375px viewport)
  - No access to admin UI elements

### 2. Manager / Admin Test Account (Correction + Audit Flow Tester)
- **Email:** (owner to provide, e.g., `manager-test@staging.example`)
- **Password:** (owner to provide)
- **Firestore `/users/{uid}`:**
  - `uid`
  - `email`
  - `name`: "Test Manager"
  - `role`: "manager"   (or "admin" for full access)
  - `active`: true
  - `timezone`: "America/Los_Angeles"
- **Purpose:**
  - Login as elevated role
  - Access TeamDashboard or AdminTimesheetReview
  - View other employees' time entries
  - Perform correction (AdminTimesheetReview or AdminPanel)
  - Verify **mandatory reason** is required (empty reason blocked by UI + service + rules)
  - Verify correction creates `auditLogs` entry **before** mutating `timeEntries`
  - Verify `status` changes to 'corrected' or similar
  - Verify audit log is immutable (subsequent attempts to edit/delete audit should fail per rules)
  - Export CSV / payroll report (verify compatibility, columns, no data loss for voided entries if filtered)
  - Confirm employee-level clock UI is still available or appropriately separated

### 3. (Optional but Recommended) Second Employee Account
- Different UID for testing cross-employee isolation (manager can see both, employee cannot see other).
- Useful for TeamDashboard filtering and permission tests.

### 4. (Optional) Inactive / Deactivated Account
- `active: false` to test isActive() rule enforcement.

---

## Local Emulator vs Real Staging Project Seeding (Critical Distinction)

**`npm run seed:test-users` (emulator only):**
- Targets **local Auth and Firestore emulators** only (hardcoded to `http://127.0.0.1:9099` in the script + uses `@firebase/rules-unit-testing`).
- **Requires** `firebase emulators:start --only auth,firestore` (or full emulator suite) running locally.
- **Does NOT** require `firebase login`, does NOT target any real Firebase project (including staging), and does NOT need .firebaserc aliases.
- Safe for local development and rules testing.
- Creates test users like admin@test.local / manager@test.local / employee@test.local with password "Test123!".
- Does **not** seed a real staging environment.

**`npm run seed:prod-test-users` (real projects, including staging):**
- Uses the real Firebase JS SDK + the app's Firebase config.
- Requires real admin credentials via environment variables: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TEST_PASSWORD` (≥6 chars).
- May also require Firebase config variables (e.g., via `.env` or by ensuring `src/config/firebase.config.js` + any VITE_ overrides point to the **staging** project during the seed run).
- Signs in as the admin user (must already exist with admin role in the target project) and provisions additional test users via `provisionUser`.
- **Use this for a real dedicated staging Firebase project** (after `firebase login` and with `.firebaserc` "staging" alias or by temporarily configuring the app to point to staging).
- **Never** run this against the production project (`atd-time-tracking`) without explicit owner approval.

**Rule:** For any real staging deployment validation, always use `seed:prod-test-users` with env vars configured for the staging project. The `seed:test-users` script is intentionally isolated to emulators.

---

## How to Create These Accounts (Owner Steps)

1. **In Firebase Console (or CLI) for the target project (staging or emulator):**
   - Go to Authentication → Users → Add User (or use `firebase auth:import` / emulator UI).
   - Note the UID generated.

2. **For real staging project seeding (preferred for validation):**
   ```bash
   # Ensure .firebaserc has staging alias + you are logged in
   # Set env vars that make the app's Firebase config + authService target the *staging* project
   ADMIN_EMAIL=your-staging-admin@... \
   ADMIN_PASSWORD=... \
   TEST_PASSWORD=TestPass123! \
   npm run seed:prod-test-users
   ```
   - Review `scripts/seed-prod-test-users.mjs` — it requires the admin to already exist with proper role in the target (staging) project.
   - This is the script to use for `atd-time-tracking-staging` or equivalent.

3. **For local emulator development/testing only:**
   ```bash
   firebase emulators:start --only auth,firestore
   # In another terminal
   npm run seed:test-users
   ```
   - Then run the app with `VITE_USE_EMULATORS=true npm run dev`.

4. **Manual Firestore seed (if script insufficient):**
   - After creating Auth users in the target (real staging project or emulator UI), manually create matching documents in the `users` collection.
   - Ensure `role` and `active: true` fields (critical for Firestore rules and UI role checks).

5. **Never commit passwords or real UIDs** to the repository.

6. **Document the actual credentials** used for a given staging deployment in a private owner-only location (e.g., 1Password, internal wiki, or encrypted note). Update this file only with placeholders or "see internal credentials doc".

---

## Validation Scenarios That Require These Accounts

From the main staging validation checklist:

**Employee Flow (requires Employee account):**
- Login screen loads
- Employee dashboard / ClockPunch visible
- Clock in works (creates active time entry)
- Double clock-in blocked
- Clock out works
- Clock out without active blocked
- Layout at phone width

**Admin / Manager Flow (requires Manager/Admin account + at least one Employee account with time data):**
- Admin dashboard loads
- AdminTimesheetReview visible
- Correction requires non-empty reason (UI + backend)
- Empty reason blocked
- Correction writes to auditLogs before mutating timeEntries (verifiable via Firestore console after action)
- Export behavior / Payroll CSV compatibility
- No hard-delete UI exposed

**Security / Data (requires both roles + ability to inspect Firestore):**
- Firestore rules deployed (if deploy eventually succeeds)
- `auditLogs` update/delete denied for all roles (test by attempting via console with different auth contexts or rules-unit-tests once emulator compatible)
- Employee cannot access admin views through normal UI navigation
- Void operations set `status: 'voided'` and preserve record + audit

---

## Local Emulator Limitation (Why Real Staging Accounts Are Still Needed)

Even running:
```bash
VITE_USE_EMULATORS=true npm run dev
# or with ?emu in URL
```
- The emulators start (if `firebase emulators:start` is running).
- You can create accounts via the Auth Emulator UI (http://127.0.0.1:4000).
- However:
  - Rules are only enforced locally.
  - No persistent cross-session state like real staging.
  - For real staging, use `seed:prod-test-users` with env configuration for the staging project. The `seed:test-users` script is intentionally limited to local emulators only.
  - Role-based UI (hiding admin panels for employees) and Firestore permission errors are hard to fully simulate for all flows.
  - Audit log immutability and correction atomicity are best verified against real deployed rules + real data.

Local emulator is excellent for development but **insufficient** for the official staging validation sign-off.

---

## Once Staging Is Available

Owner should:
1. Resolve all items in STAGING_DEPLOY_BLOCKER_REPORT.md.
2. Deploy to staging (hosting + rules + indexes).
3. Run the appropriate seed script for the real staging project (`npm run seed:prod-test-users` with correct env vars for staging; see the "Local Emulator vs Real Staging Project Seeding" section). `npm run seed:test-users` is only for local emulators.
4. Record the actual test account emails/passwords in a secure location.
5. Provide the staging URL + credentials to the validation agent or QA owner.
6. Re-invoke the Staging Deployment Agent (or perform manual validation) against the live staging URL.
7. Update this document with the actual account details used (redacted public version).

---

## Current Status (2026-05-25)

- **Test accounts in this workspace / local env:** None.
- **Seeding possible here:** No (no Firebase auth, no target project).
- **Validation performed:** Code-level + static analysis only (see main report).
- **Blocker:** Entirely due to missing staging infrastructure and credentials (not a code defect).

---

*This document does not contain any real credentials, passwords, or UIDs.*
*It is safe to commit.*
