# Firebase Staging Setup Guide (TimeTrack)

**Date:** 2026-05-25  
**Status:** Infrastructure preparation complete. Deployment still requires owner action to create the actual staging project and authenticate.

**Goal:** Enable safe, repeatable deployment to a dedicated staging Firebase environment without any risk to production (`atd-time-tracking`).

---

## Prerequisites (Owner Must Complete)

1. Create a **dedicated staging Firebase project** in the Firebase Console.
   - Recommended ID: `atd-time-tracking-staging`
   - Same region preference: `us-west2`
   - Enable Authentication (Email/Password) + Firestore (Native mode)

2. Note the new Project ID.

3. (Optional but recommended) Create a separate Firebase Hosting site inside the staging project if you want isolated hosting.

---

## Step-by-Step Setup

### 1. Firebase CLI Login (One-Time)

```bash
firebase login
```

- Opens browser. Log in with the Google account that has **Editor or Owner** access to the **staging** project (and separately to production when you are ready for that).
- Do **not** run any deploy commands yet.

### 2. Configure Project Aliases (Critical Safety Step)

From the repo root (after this PR lands):

```bash
# Copy .firebaserc.example to .firebaserc and replace the staging placeholder with your real staging project ID
firebase use --add
```

When prompted:
- Select the staging project you just created.
- Give it the alias `staging`
- Also add the existing production project as alias `production` (or `default`)

After copying `.firebaserc.example` → `.firebaserc` and filling the real staging ID, it should look like:

```json
{
  "projects": {
    "default": "atd-time-tracking",
    "staging": "atd-time-tracking-staging",
    "production": "atd-time-tracking"
  }
}
```

**Never** deploy without the `--project staging` flag or the `firebase use staging` command until you are 100% sure of the current alias.

### 3. (Future) Make Firebase Config Support Staging

Currently `src/config/firebase.config.js` is hardcoded to the production project.

For full isolation, the recommended next step after this PR is to update the config loader so that `VITE_FIREBASE_PROJECT_ID` etc. (from `.env.staging` or CI) can override the values at build time.

Until that is done, one common pattern is:
- Temporarily edit the config file to point at staging before a manual deploy, or
- Use separate build commands that swap the config file.

Document any change in a follow-up PR.

---

## Safe Staging Deployment Commands

**Always** use one of these patterns. Never run a bare `firebase deploy`.

### Preferred: Explicit project flag (works even without `firebase use`)

```bash
# After `npm run build`
firebase deploy \
  --only hosting,firestore:rules,firestore:indexes \
  --project staging
```

### Or: Switch alias first (then you can omit --project)

```bash
firebase use staging
firebase deploy --only hosting,firestore:rules,firestore:indexes
firebase use default   # switch back when done (good hygiene)
```

### Deploy only rules + indexes (very safe, no hosting change)

```bash
firebase deploy --only firestore:rules,firestore:indexes --project staging
```

### Hosting preview channel (zero risk to any live site, even in staging project)

This is excellent for quick UI validation without touching the "live" hosting of the staging project:

```bash
firebase hosting:channel:deploy staging-2026-05-25 --expires 2d --project staging
```

Gives you a URL like:
`https://atd-time-tracking-staging--staging-2026-05-25.web.app`

---

## What Gets Deployed to Staging

- `hosting` → the built SPA (`build_output/`)
- `firestore:rules` → current `firestore.rules` (immutable audit logs, role checks, etc.)
- `firestore:indexes` → the two indexes in `firestore.indexes.json`

**Never** deploy functions (we removed the broken reference in this PR).

---

## Test Accounts on Staging

See `STAGING_TEST_ACCOUNT_REQUIREMENTS.md` (updated in this PR for accuracy).

- Use `npm run seed:prod-test-users` (with the three required ADMIN_* / TEST_* env vars) **only after** the Firebase config + auth in the Node process are pointed at the staging project.
- `npm run seed:test-users` is **emulator only** — do not use it for the real staging project.

---

## Post-Deploy Validation (Owner / QA)

1. Visit the staging URL (or channel URL).
2. Log in with a freshly seeded employee test account.
3. Perform full clock in → lunch → clock out flow.
4. As admin/manager test account: perform a correction that includes a non-empty reason and verify the audit log entry appears **before** the time entry is mutated.
5. Confirm that an employee account cannot see admin UI tabs.
6. Attempt (in Firestore console, with appropriate auth) to edit or delete an audit log document → should be denied by rules.
7. Export CSV and spot-check that voided entries are still present with their original data (payroll compatibility).
8. Test on a real phone (375px width) for tap targets and layout.

See the full checklist in the earlier `STAGING_DEPLOYMENT_AND_VALIDATION_REPORT.md`.

---

## Production Remains Strictly Blocked

- The `production` alias in `.firebaserc` exists only as a marker.
- No production deploy script was added.
- No one should run any command with `--project production` or the production alias until:
  - Owner has explicitly approved after successful staging validation
  - All items in the Production Approval Gate (PHASE1_ROLLOUT_CHECKLIST.md) are checked
  - A separate production deployment PR / ticket exists

---

## Common Mistakes to Avoid

- Running `firebase deploy` with no `--project` or alias set → may hit the wrong project.
- Using `npm run seed:test-users` against a real project ID → it will fail or target the wrong thing.
- Forgetting to run `npm run build` before a hosting deploy (hosting serves `build_output`).
- Leaving the Firebase config file pointed at production while trying to seed or test against staging.

---

## Next Commands (After Owner Creates the Staging Project)

```bash
# 1. Login (if not already)
firebase login

# 2. Add the staging project under the "staging" alias
firebase use --add

# 3. (Optional) verify
firebase projects:list
cat .firebaserc   # (after you have copied + edited the .example)

# 4. Build + safe deploy
npm run build
firebase deploy --only hosting,firestore:rules,firestore:indexes --project staging

# 5. Or use a preview channel for even lower risk
firebase hosting:channel:deploy my-first-staging-test --expires 7d --project staging
```

---

**This document + the accompanying `.firebaserc.example` template (copy to .firebaserc), env examples, and safe scripts in this PR make the repository ready for the owner to complete the final one-time setup steps above.**

No production deployment was performed. No Phase 2 work was started.
