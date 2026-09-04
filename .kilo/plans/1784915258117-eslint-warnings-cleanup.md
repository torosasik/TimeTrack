# Fix TZ-Fragile Test: dateHelpers › formatDateYYYYMMDD zero-pads

## Goal
Make `src/utils/utilities.test.ts:32` pass deterministically on any machine timezone. **No production-code change** — `formatDateYYYYMMDD` is correct per the AGENTS.md timezone guardrail (PT-anchored formatting); the test input is the bug.

## Diagnosis (verified)
- `src/utils/dateHelpers.js:46` `formatDateYYYYMMDD(date)` formats the instant in `America/Los_Angeles` (correct, guardrail-mandated).
- The test builds input with `new Date(2025, 0, 5)` — a **local-time constructor** (midnight Jan 5 in the runner's TZ).
  - UTC+3 machine: instant = `2025-01-04T21:00Z` → `2025-01-04 13:00 PT` → returns `"2025-01-04"`, test fails.
  - Only machines at UTC-8 or west (PT dev machines) pass — why the team never saw it.
- Sibling tests in the same file already use explicit UTC instants (e.g. lines 346, 351 test the same function with `'2026-06-15T12:00:00Z'`). Line 32 is a leftover from before the file's TZ-hardening pass.
- Confirmed pre-existing: fails identically on the clean tree before the ESLint cleanup.

## Decision (agreed)
**Option A — fix the test input.** Rejected: pinning `TZ=America/Los_Angeles` globally for Jest (needs cross-env on Windows, changes env for all tests, masks the bad constructor). Rejected: documenting-only (no behavior fix).

## Task list
1. Edit `src/utils/utilities.test.ts` line 32:
   ```ts
   it('formatDateYYYYMMDD zero-pads', () => {
       // Anchor at noon UTC: PT is always UTC-7/-8, so the instant falls on the
       // same PT calendar day on any machine TZ. A local constructor like
       // `new Date(2025, 0, 5)` would be TZ-dependent (fails east of UTC-8).
       expect(formatDateYYYYMMDD(new Date(Date.UTC(2025, 0, 5, 12)))).toBe('2025-01-05');
   });
   ```
2. Verify: `npx jest` → **353/353 pass** (previously 352/353 with this single failure).
3. Verify: `npm run lint` → still 0 problems.

## Constraints / guardrails
- Do NOT change `src/utils/dateHelpers.js` — its PT anchoring is the mandated behavior (AGENTS.md §Guardrails, `.kilo/rules/timezone-enforcement.md`).
- Keep the test's stated purpose: month/day zero-padding (`01`/`05`).
- No Firestore/rules impact; `npm run test:rules` not required.

## Risks
- None material. The new anchor is deterministic year-round (PT offset is UTC-7 PDT / UTC-8 PST; noon UTC always lands on the same PT calendar day).

## Validation
- `npx jest` — 353/353 green on this UTC+3 machine (previously failing).
- Optional cross-check: run with `TZ=America/Los_Angeles` and `TZ=UTC` env vars to confirm TZ-independence.
