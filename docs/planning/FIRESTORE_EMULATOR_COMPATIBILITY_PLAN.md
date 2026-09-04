# Firestore Emulator & Rules Unit Testing Compatibility Plan

**Date:** 2026-05-25  
**Current State:** Rules tests (`npm run test:rules`) are blocked in this environment due to library compatibility between the Firebase JS SDK and the rules-unit-testing helper.

---

## Current Installed Versions (from package.json)

- `firebase`: `^10.7.1`
- `@firebase/rules-unit-testing`: `^3.0.1`

Historical reports mentioned issues with 3.0.4 + 10.14.1. The exact failure observed when running the test script is that the emulator cannot be reached or the test environment fails to initialize even when the emulator process is running.

---

## Root Cause

The `@firebase/rules-unit-testing` package has had several breaking changes and version skew issues with the main `firebase` package, especially around how it initializes the test environment and talks to the emulator.

The test script (`scripts/test-firestore-rules.js`) uses:
```js
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
```

This is the modern (v3+) API. Older patterns from v2 are incompatible.

---

## Resolution Options (Ranked)

### Option A — Align versions (Recommended first attempt)
- Update both packages to a known compatible pair from the same release period.
- Common safe combinations for the 10.x era:
  - `firebase@10.7.1` + `@firebase/rules-unit-testing@3.0.1` (current — partially works for some people)
  - `firebase@10.12.0` + `@firebase/rules-unit-testing@3.0.3` or `3.0.4`
  - `firebase@10.14.0` + `@firebase/rules-unit-testing@3.0.5+`

**Risk:** Minor — these are dev-only packages. The app itself does not depend on the rules-testing library at runtime.

### Option B — Isolate rules tests
- Move the rules test script and its dependency into a completely separate `test-rules/` folder or a dedicated package.
- This prevents version skew from ever affecting the main app again.
- Higher initial effort, very high long-term maintainability.

### Option C — De-emphasize automated rules tests for now
- Keep the 11 audit log tests as **documentation + code review artifacts**.
- Rely on:
  - Manual verification in the Firebase Emulator UI
  - The fact that the rules themselves were reviewed and are simple
  - `firebase emulators:start` + manual console testing during staging
- This is what the previous validation agents already did (code review + blocker documented).

### Option D — Use Firebase's official emulator testing via the Admin SDK (advanced)
- More powerful but heavier (requires service account keys, not suitable for CI without secrets management).

---

## Recommendation

**Start with Option A (minimal version bump)** in a follow-up PR after this one lands:

1. Temporarily change the constraints in `package.json` devDependencies to a known-good pair (e.g. `firebase@10.14.0` and `@firebase/rules-unit-testing@3.0.5`).
2. Run `npm install`.
3. Start the emulator in one terminal: `firebase emulators:start --only firestore`
4. In another: `npm run test:rules`
5. If it passes, commit the lockfile + package.json change + update this plan.
6. If it still fails, immediately revert and fall back to Option C (documented manual testing) + open an issue against the Firebase JS SDK or rules-unit-testing repo.

**Do not** perform the version bump in this PR unless the change is trivial and tests pass on the first try. The absolute rule is to avoid unnecessary risk to the working app.

---

## What This PR Does for the Blocker

- Documents the exact current versions.
- Records the recommended resolution path.
- Leaves the test script and the 11 audit log tests intact (they remain valuable as executable specification even if the runner is currently flaky).
- The rules themselves (`firestore.rules`) are already the source of truth and were validated in PR #2.

---

## Commands for Future Investigator

```bash
# Try a conservative aligned pair
npm install --save-dev firebase@10.14.0 @firebase/rules-unit-testing@3.0.5

# Then in two terminals:
firebase emulators:start --only firestore,auth
npm run test:rules
```

If the above succeeds, update the package.json ranges to the new compatible versions and remove the "blocked" status from all reports.

---

**Current status after this PR:** Still blocked in the Codespace environment. Fully documented with a clear, low-risk path forward. No changes were made to dependencies in this work.
