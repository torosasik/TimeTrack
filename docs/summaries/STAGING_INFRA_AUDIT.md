# Staging Infrastructure Audit

**Date:** 2026-05-25  
**Branch:** infra/staging-firebase-setup (from fixed report/staging-deployment-validation)  
**Main Commit Base:** c6f87dcec85fd2ec4cbc5a3d5d4ec9f953eb2c10 + docs fixes  
**Purpose:** Systematic review of all Firebase-related configuration, scripts, and files to identify staging readiness gaps. No credentials or secrets were read or created.

---

## 1. Files Present

| File | Status | Notes |
|------|--------|-------|
| `firebase.json` | Present | Full config for hosting, firestore, emulators, and **functions** (broken) |
| `.firebaserc` | **MISSING** | No project aliases at all. This is the #1 blocker for safe `firebase deploy --project staging` |
| `firestore.rules` | Present (4541 bytes) | Current hardened rules (auditLogs immutable, etc.) |
| `firestore.indexes.json` | Present (629 bytes) | 2 indexes (timeEntries, correctionRequests) |
| `package.json` | Present | Scripts include `test:rules`, `seed:test-users`, `seed:prod-test-users`, `lint`. No deploy scripts yet. |
| `vite.config.js` | Present | Build outDir = `build_output` (matches firebase.json hosting.public). No special Firebase env plugin. Standard Vite `import.meta.env.VITE_*` available to client. |
| `src/config/firebase.config.js` | Present | **Single hardcoded project** `atd-time-tracking`. Public web config (apiKey etc. are normal for Firebase client SDK). No env loading. |
| `src/app/lib/firebase.ts` | Present | Main init. Emulator wiring only via `VITE_USE_EMULATORS=true` or `?emu`. Imports the single config. |
| `src/firebase.js` (legacy) | Present | Simple re-export of same config. Used by `seed:prod-test-users.mjs`. |
| `functions/` directory | **DOES NOT EXIST** | `firebase.json` references it with predeploy `npm run build` inside the dir. Will break any deploy that touches functions. |
| `.env*` files | None in workspace | Expected (gitignore + security). No `.env.example` or `.env.staging.example` provided. |

---

## 2. Firebase Project Configuration

- **Only one project ID referenced anywhere:** `atd-time-tracking`
  - Appears to be the production / sole existing project.
  - No evidence of a separate `atd-time-tracking-staging` project in code, docs (pre-infra), or config.
- No use of `import.meta.env.VITE_FIREBASE_*` or similar for runtime project switching.
- The `firebaseConfig` object is plain JS with literal values. To support staging, this must be made env-aware (or we maintain separate config files + build-time selection).
- `APP_DOMAIN` / `APP_URL` are placeholders.

**Risk:** Any `firebase deploy` (once auth + .firebaserc exist) without explicit `--project` will target whatever "default" is after `firebase use --add`. High chance of hitting the real project.

---

## 3. Hosting Configuration

- `public: "build_output"` — correct (Vite builds here).
- SPA rewrite + aggressive no-cache headers on assets (good for SPA, but may need tuning for prod caching strategy later).
- No `site` or `target` configured (would be in .firebaserc or firebase.json for multi-site).

**Safe for staging hosting deploys** once project alias exists.

---

## 4. Firestore Configuration

- Rules path and indexes path correctly declared.
- Location: `us-west2`.
- Current rules (post-PR #2) correctly implement immutable auditLogs (`allow update, delete: if false`).

**Firestore rules + indexes are ready to deploy** to a staging project via `--only firestore:rules,firestore:indexes`.

---

## 5. Functions Configuration (Broken)

- `firebase.json` declares a functions codebase pointing to non-existent `functions/` dir.
- Predeploy step assumes a package.json inside `functions/`.
- **Impact:** Any deploy command that does not explicitly exclude functions (or the whole default codebase) will fail during predeploy.
- No actual Cloud Functions code exists in the repo (no `functions/src/index.ts` or equivalent).

**Recommendation implemented later in this work:** Remove or comment out the functions stanza in firebase.json for now (or mark it disabled). Do not create fake functions code.

---

## 6. Emulators

- Well configured in firebase.json (auth 9099, firestore 8080, hosting 5000, UI 4000).
- App supports opt-in emulator mode.
- `npm run test:rules` script exists and expects emulator running.
- **Known blocker:** `@firebase/rules-unit-testing@^3.0.1` + `firebase@^10.7.1` compatibility issues (emulator fails to init in some environments). Documented in separate plan.

---

## 7. Scripts (package.json)

Current relevant scripts:
- `test:rules` — runs the rules test script against local emulator.
- `seed:test-users` — emulator-only (confirmed by inspecting `scripts/seed-test-users.mjs` — uses hardcoded localhost emulator URLs + rules-unit-testing).
- `seed:prod-test-users` — real project (uses real Firebase SDK + env vars `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TEST_PASSWORD` + `provisionUser` from authService). Intended for production-like environments.

**No staging deploy scripts exist yet.** This work will add safe ones (e.g., `deploy:staging` that forces `--project staging`).

---

## 8. Environment Variable Usage

- Vite standard: only `VITE_*` vars are exposed to browser code.
- No current VITE_FIREBASE_* vars in use.
- The prod seed script bypasses Vite entirely (Node) and relies on the imported firebase config + explicit admin env vars.
- No `.env.example` guidance for contributors or for pointing a staging run at a different project.

---

## 9. Legacy vs Current Firebase Init

- `src/firebase.js` (legacy, used by seed script) and `src/app/lib/firebase.ts` (current app) both ultimately load the **same single** `firebase.config.js`.
- This duplication is a minor tech debt but not a blocker for staging setup.

---

## 10. Summary of Blockers (Pre-Work)

1. **Critical:** No `.firebaserc` → no safe way to say "deploy only to staging".
2. No dedicated staging Firebase project created in console (only `atd-time-tracking` known).
3. Hardcoded single-project Firebase config (no env switching).
4. Broken `functions` reference in firebase.json.
5. No `.env*.example` files or documented staging env setup.
6. No safe staging deploy / channel scripts.
7. Emulator rules tests have library compatibility issues.
8. No test accounts seeded anywhere accessible.
9. Documentation (pre-fix) had inaccuracies around dry-run and seeding (now corrected in this branch).

---

## 11. Files Safe to Modify in This Work (Per Absolute Rules)

- Config files (firebase.json, add .firebaserc, env examples, docs)
- package.json scripts (staging-only, never auto-prod)
- Documentation only

**Never modify:**
- Business logic (time entry, correction, audit, overtime, etc.)
- Firestore rules (unless purely to support staging testing, and only with owner review)
- Any hard-delete paths
- Any production deployment paths

All work in this branch stayed within repo-level configuration and documentation.

---

*Audit performed without any Firebase login, without touching any real projects, and without creating or reading any secrets.*
