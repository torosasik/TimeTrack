# Staging Deployment Blocker Report

**Date:** 2026-05-25  
**Agent:** Staging Deployment Agent  
**Main Commit:** c6f87dcec85fd2ec4cbc5a3d5d4ec9f953eb2c10  
**Status:** DEPLOYMENT BLOCKED - Credentials and configuration missing

---

## Summary

Staging deployment to Firebase could not be performed because the environment lacks the necessary Firebase project configuration, authentication, and target aliases to safely deploy to a staging environment without risking the production project.

Per absolute rules: "If credentials are missing, stop deployment only and document exact missing items. Continue with local validation."

Deployment was **not attempted**. Local pre-staging checks were completed successfully. Validation proceeded via code-level review and static analysis.

---

## Exact Missing Items (Blockers)

### 1. Firebase CLI Authentication
- **Command attempted:** `firebase projects:list`
- **Error:** `Error: Failed to authenticate, have you run firebase login?`
- **Impact:** Cannot list projects, deploy, or interact with any Firebase project.
- **Required action:** `firebase login` (interactive, requires browser/Google account with access to the Firebase project(s)).

### 2. No .firebaserc File (Project Aliases)
- **File:** `.firebaserc` — does not exist in repository root.
- **Impact:** Firebase CLI has no knowledge of project IDs, aliases (e.g., "default", "staging", "prod"), or deploy targets.
- **Typical expected content (not present):**
  ```json
  {
    "projects": {
      "default": "atd-time-tracking-staging",
      "prod": "atd-time-tracking",
      "staging": "atd-time-tracking-staging"
    }
  }
  ```
- **Risk if ignored:** Any `firebase deploy` would target the "default" project (if logged in), which from code is `atd-time-tracking` (appears to be the primary/production project). High risk of accidental production impact.

### 3. Single Firebase Project ID, No Staging Project Configured
- **File:** `src/config/firebase.config.js`
  - `projectId: "atd-time-tracking"`
  - `authDomain: "atd-time-tracking.firebaseapp.com"`
- **Evidence in repo:** All documentation and code reference only this single project ID. No VITE_FIREBASE_* overrides, no `.env.staging`, no separate staging config module.
- **Deployment docs (docs/deployment/DEPLOYMENT_GUIDE.md, PHASE1_ROLLOUT_CHECKLIST.md):** Reference "Firebase staging project configured" as a manual checklist item, but no implementation or project ID is provided in the repository.
- **Conclusion:** No separate staging Firebase project exists or is configured in this codebase/environment. Deploying would target the primary project.

### 4. Environment Variables / Config Separation Missing
- No `.env` files present (expected, as they are typically gitignored).
- No `.env.example` or documented VITE_ variables for switching Firebase projects between environments.
- Firebase initialization (`src/app/lib/firebase.ts`) hard-references the single `firebase.config.js` with no runtime switching for staging vs prod.
- **Impact:** Even with auth, the built app would always connect to the same Firebase project (`atd-time-tracking`).

### 5. Non-Existent Functions Directory Referenced in Config
- `firebase.json` declares:
  ```json
  "functions": {
    "source": "functions",
    ...
    "predeploy": ["npm --prefix \"$RESOURCE_DIR\" run build"]
  }
  ```
- **Reality:** `functions/` directory does not exist (`ls: cannot access 'functions/': No such file or directory`).
- **Impact:** Any deploy that includes functions (even accidentally) would fail predeploy. Hosting-only deploys might succeed but config is inconsistent.

### 6. No Documented Staging Hosting Channel or Target
- Firebase Hosting supports preview channels (`firebase hosting:channel:deploy preview --expires 7d`) for safe staging without a separate project.
- No usage of channels, no scripts in package.json, no documentation on channel-based staging workflow.
- Current hosting config points to `build_output/` (correct after `npm run build`), but no safe deployment path configured.

### 7. Firebase Emulator / Local Testing Only
- Emulators configured in `firebase.json` (auth:9099, firestore:8080, hosting:5000).
- App supports `VITE_USE_EMULATORS=true` or `?emu` query param for local-only testing.
- **Impact:** Useful for local development, but does not substitute for a real staging Firebase project (no shared state, no real auth, no production-like rules enforcement beyond local).

---

## Risk Assessment

- **Accidental Production Deploy Risk:** HIGH if `firebase login` is performed without `.firebaserc` aliases and deploy commands are run without `--only hosting` or explicit project flags.
- **Data Integrity Risk:** Deploying rules/indexes to the wrong project could overwrite production security rules.
- **No Rollback Path:** Without channels or separate staging project, there is no isolated environment for validation.

---

## What Would Be Required for Staging Deploy

1. **Firebase Project:**
   - A separate staging Firebase project created in Firebase Console (recommended project ID: `atd-time-tracking-staging` or similar).
   - Copy of production configuration (auth, Firestore, etc.), but empty or seeded with test data only.

2. **Configuration in Repo:**
   - `.firebaserc` with aliases:
     ```json
     {
       "projects": {
         "default": "atd-time-tracking-staging",
         "staging": "atd-time-tracking-staging",
         "prod": "atd-time-tracking"
       }
     }
     ```
   - Environment-based Firebase config (e.g., `src/config/firebase.config.staging.js` + VITE_ overrides, or runtime detection).
   - Or use Firebase Hosting preview channels + separate Firestore project for rules (more complex).

3. **Authentication:**
   - `firebase login` performed by a user with Editor/Owner access to the staging project (and separately for prod when approved).

4. **Scripts / CI:**
   - Add to package.json: `"deploy:staging": "firebase deploy --only hosting,firestore:rules,firestore:indexes --project staging"`
   - Document in DEPLOYMENT_GUIDE.md.

5. **Test Data:**
    - For real staging project: Use `npm run seed:prod-test-users` (with ADMIN_EMAIL/ADMIN_PASSWORD/TEST_PASSWORD env vars + Firebase config/env pointing to the staging project). 
    - `npm run seed:test-users` is for local emulators only (requires `firebase emulators:start --only auth,firestore`); it does not seed real projects and does not require `firebase login`.
    - Document test account credentials (never committed).

6. **Optional Safer Path (Recommended):**
   - Use Hosting preview channels on the existing project for UI validation: `firebase hosting:channel:deploy staging-2026-05-25 --expires 2d`
   - This gives a temporary URL like `atd-time-tracking--staging-2026-05-25.web.app` without touching live hosting.
   - Still requires separate Firestore project or emulator for data/rules isolation.

---

## Actions Taken

- **Deployment attempt:** NONE (correctly aborted per rules).
- **Pre-staging checks:** Completed locally (see STAGING_DEPLOYMENT_AND_VALIDATION_REPORT.md).
- **Local validation:** Performed via code inspection, static analysis, and review of hardening changes from PR #2.
- **Blocker report:** This document created.
- **Test account requirements:** See STAGING_TEST_ACCOUNT_REQUIREMENTS.md (created because runtime validation impossible without seeded accounts on a real staging backend).

---

## Local Validation Performed (Instead of Deploy)

Since deployment was blocked, the following were validated statically against the main commit:

- TypeScript: PASS
- Build: PASS
- Tests: PASS (11/11)
- Lint: 30 errors / 141 warnings (pre-existing, documented, non-blocking)
- Hard delete safety: Confirmed (no `deleteDoc` on timeEntries in UI components; void uses `status: 'voided'` + `auditLogService.logVoidEntry()`)
- Audit log immutability: Confirmed in `firestore.rules` (`allow update, delete: if false;`)
- Payroll CSV: Unchanged
- No Phase 2 code, no Operation Hub, no billing features
- Production deployment remains explicitly blocked in all reports

Full details in the main staging validation report.

---

## Recommendation

**Do not attempt deployment until the 7 missing items above are resolved by the repository owner.**

**Next steps for owner:**
1. Create dedicated staging Firebase project.
2. Add `.firebaserc` with aliases (never commit real credentials).
3. Implement environment-specific Firebase config.
4. Run `firebase login` in a secure environment with staging access.
5. Add safe deploy scripts (prefer Hosting channels for low-risk UI previews).
6. Seed test accounts: use `npm run seed:prod-test-users` (with proper env vars) for the real staging project; `npm run seed:test-users` only for local emulator development.
7. Re-run this agent or perform manual staging deploy + validation.

Once staging is available and populated, the validation items in the main report (employee clock flows, admin correction with mandatory reason + audit, mobile layout, security rules enforcement) can be executed against the live staging URL.

**Production status:** Remains BLOCKED. This staging blocker does not change the production gate.

---

*Report generated by Staging Deployment Agent following all absolute rules.*
*No deployment commands were executed against any Firebase project.*
