# Plan: Stop greying punch buttons during background refresh

## Context & root cause

The employee `ClockPunch` screen has two action buttons whose `disabled` predicates disagree:

- **Primary button** (`CLOCK IN` / `CLOCK OUT` / `END LUNCH`) at `src/app/components/employee/ClockPunch.tsx:280`:
  `disabled={!!actionLoading || loading}` — includes the `loading` flag.
- **Lunch button** (`START LUNCH` / `END LUNCH`) at `src/app/components/employee/ClockPunch.tsx:299`:
  `disabled={lunchUsed || !canDoLunch || !!actionLoading}` — omits `loading`.

`loading` is set to `true` at the top of `load()` (`ClockPunch.tsx:48`). `load()` runs on mount and on a 60s auto-refresh interval (`ClockPunch.tsx:67`). Every background refresh therefore flips `loading=true` for the fetch duration, which disables (greys out) the primary button but leaves the lunch button untouched. That asymmetry is the reported behavior — it is an oversight in the predicate, not intentional.

For comparison, the legacy `TodayEntry` surface (opt-in via `?classic=1`) disables its punch buttons on `submitting || !!blockedMessage` (`TodayEntry.tsx:776/884/896`) and does **not** grey during a refresh either — so `ClockPunch`'s primary button is the odd one out across the app.

## Decision

**Stop greying on refresh.** Remove the `|| loading` term from the primary button's `disabled` so it matches the lunch button (and the legacy `TodayEntry`). Neither punch button greys during a background read-refresh; both still grey during the user's own in-flight punch via `actionLoading`.

## Change (single file, one line)

`src/app/components/employee/ClockPunch.tsx:280`

```diff
-           disabled={!!actionLoading || loading}
+           disabled={!!actionLoading}
```

No change to the lunch button (`:299`) — it already lacks `loading`.

Do **not** add explanatory comments (per AGENTS.md "no comments unless asked").

## What is intentionally NOT changed

- **Initial-load full-screen spinner** (`ClockPunch.tsx:164`, `if (loading && !status)`): kept. That guard only fires when there is no `status` yet (first mount), i.e. the skeleton state — not a refresh grey-out. The reported issue is specifically about subsequent refreshes where `status` already exists.
- **Refresh footer button** (`ClockPunch.tsx:361`, `disabled={loading || !!actionLoading}`): kept. That *is* the refresh action itself; disabling it mid-refresh is correct and its spinner (`:364`) provides the "refreshing" visual feedback.
- **Retry button** in the `writeFailure` banner (`ClockPunch.tsx:244`, `disabled={!!actionLoading}`): already correct, no `loading`.
- **Spinner icon** on the primary button (`ClockPunch.tsx:285`): keyed off `actionLoading`, so a background refresh shows the normal icon with no spinner — correct, no change.
- **Lunch button** predicate (`:299`): already correct, no change.

## Safety justification (why removing `loading` is safe)

`loading` on the primary `disabled` is not load-bearing for safety. The guards that actually matter are all independent of it:

1. **`punchInFlight` ref** (`ClockPunch.tsx:45`, checked at `:104/:124/:144`) — synchronous double-click/double-dispatch guard that runs on every call, immune to React's async setState.
2. **`actionLoading`** — disables the same button the moment the user's own punch starts, preventing re-entry of that action.
3. **`writeFailure` banner** (`ClockPunch.tsx:40`, `:214-262`) — persistent failure surface with Retry, so a lost write is recoverable, not silent.

The write layer is **server-authoritative**, so a punch firing concurrently with an in-flight background read is correct:

- `punchIn` / `punchOut` / `toggleLunch` (`src/services/clockService.ts:121 / 224 / 307`) take only `userId` — they do **not** consume the component's client-side `status`.
- Each re-locates the open shift server-side via `findOpenShiftEntry(userId)` at the start, then validates inside `runTransaction` (`validateCanPunchIn` / `validateCanPunchOut` / `validateCanToggleLunch`).
- Timestamps use `Timestamp.now()` + PT helpers (`getCurrentPTDate`, `getCurrentPTTimeHHMM`) — canonical `America/Los_Angeles` storage, consistent with the timezone rule (AGENTS.md §2, `timezone-enforcement.md`).
- Writes go through `withRetry` for transient network failures (Layer 2 hardening).

Concurrency outcome when a user taps CLOCK OUT mid-refresh: the read resolves and updates `status`; the punch transaction validates against the server doc and writes its own server timestamp; `doPunchOut` then calls `await load()` again for a fresh view. No double-write (ref guard), no stale-state write (server timestamp), no lost punch (retry + banner). The segment model and audit path are untouched.

This change touches **only** a UI `disabled` attribute on a read-refresh path. It does not modify time data, segments, overtime, or audit — so the soft-delete / segments / CA-overtime / mandatory-audit rules are not in play.

## Validation

1. `npm run lint`
2. `npm run test` — `ClockPunch.test.tsx` only exercises `timeValidation` business rules (no component render, no `loading`-disabled assertions), so it must pass unchanged.
3. `npm run test:rules` — **not required**; `firestore.rules` untouched.
4. Manual (dev server, `npm run dev`):
   - Clock in, then wait for / trigger the 60s auto-refresh. Confirm the **CLOCK OUT** button stays enabled (not greyed) during the fetch and only greys briefly while the actual clock-out is in flight.
   - While clocked in and **not** on lunch, confirm **START LUNCH** behaves identically (enabled during refresh) — parity restored.
   - Tap CLOCK OUT exactly as a refresh begins; confirm the punch lands, status updates, and no double-write / no toast error.
   - Confirm the initial (first) load still shows the full-screen spinner (skeleton) — unchanged.

## Risks / edge cases

- **Stale `status` during the fetch window:** the button label/action derive from the previous `status` until the refresh resolves. This is already the case today for the lunch button and for `TodayEntry`; removing `loading` merely makes the primary button consistent. Because writes are server-authoritative (above), stale client state cannot corrupt a punch.
- **Two concurrent `load()` calls** if the user punches during a refresh: harmless — both are idempotent reads; the punch's own `await load()` runs after its write. No change needed.
- **Perceived "no feedback during refresh":** the footer Refresh button already shows a spinning `RefreshCw` (`:364`) and the live PT clock in `ClockStatus` continues ticking, so the refresh is still visible without disabling the punch target.

## Out of scope

- Any change to the auto-refresh cadence (60s) or to `ClockStatus` / live clock.
- Any change to `TodayEntry` (already correct).
- Audit / overtime / segment logic (untouched).
- Replacing `loading`-based feedback with an explicit "refreshing" affordance on the punch buttons (not needed; footer spinner suffices).
