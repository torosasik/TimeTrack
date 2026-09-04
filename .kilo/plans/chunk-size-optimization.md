# Plan: Fix Vite chunk-size warning

## Problem
`npm run build` warns: firebase chunk is 562 kB (>500 kB default limit). Root cause = the single `firebase` manual chunk bundles `firebase/app` + `firebase/auth` + `firebase/firestore` together, and Firestore is genuinely large (made larger by the Layer 2 `persistentLocalCache` addition). Secondary inefficiency: only 8 of ~25 installed `@radix-ui/*` packages are listed in the `radix-ui` chunk, so the other 17 land in `main` (313 kB).

## Goal
Eliminate the warning via real chunking improvements (load-performance win) + a pragmatic warning-limit ceiling for the unavoidable firebase-firestore floor. No runtime behavior change.

## Investigation facts
- `vite.config.js:32-45` — current `manualChunks` (object form), 3 entries.
- Build output: `firebase` 562 kB, `main` 313 kB, `radix-ui` 257 kB, `recharts` 0.41 kB.
- `recharts` imported only in `src/app/components/ui/chart.tsx` (shadcn template), which appears unused in the active graph → near-empty chunk.
- `firebase/firestore` imported across ~12 source files; `firebase/auth` in auth paths; `firebase/app` is the tiny core.
- MUI/`@emotion`/`motion`/`embla`/`react-slick`/`react-dnd`/etc. are tree-shaken out (not in bundle) — unused dep cleanup is out of scope.
- No `React.lazy` / dynamic imports exist today.

## Changes

### 1. `vite.config.js` — convert `manualChunks` to function form + split firebase
Replace the object-form `manualChunks` (lines 32-45) with a function that matches by `node_modules` path. This is more robust than exact-id lists and catches all `@radix-ui/*` automatically.

Proposed grouping:
- `firebase-firestore` ← `firebase/firestore` (the big one, isolated so it doesn't drag auth/core)
- `firebase-core` ← `firebase/app` + `firebase/auth` (small, loads early at login)
- `radix-ui` ← any `@radix-ui/*` (all ~25 packages, not just 8)
- `vendor` ← everything else under `node_modules` (lucide-react, date-fns, sonner, class-variance-authority, clsx, tailwind-merge, cmdk, vaul, etc.) — keeps `main` to just app code
- Drop the dedicated `recharts` entry (let it fall into `vendor` if/when used; currently unused so it won't appear)

Function-form sketch:
```js
manualChunks(id) {
  if (!id.includes('node_modules')) return;            // app code stays in main
  if (id.includes('node_modules/firebase/firestore')) return 'firebase-firestore';
  if (id.includes('node_modules/firebase/'))           return 'firebase-core'; // app + auth
  if (id.includes('node_modules/@radix-ui/'))          return 'radix-ui';
  return 'vendor';
}
```

### 2. `vite.config.js` — raise `chunkSizeWarningLimit` to 700
Add `build.chunkSizeWarningLimit: 700`. Rationale: `firebase-firestore` + `persistentLocalCache` has a real ~500-550 kB floor that can't be split further without dynamic imports. 700 keeps the warning meaningful for genuine regressions while accepting the unavoidable Firebase size. (The user explicitly listed this option.)

### 3. (Optional, recommend but defer) Lazy-load heavy admin views
The only true way to shrink the *initial* firebase chunk below its floor is `React.lazy` + dynamic `import()` on the admin/manager routes (`PayrollReports`, `AdminPanel`, `TeamDashboard`, `AdminTimesheetReview`) — they're the heaviest Firestore consumers and aren't needed at first paint (employee clock-in screen is the landing view). This is an architecture change (route-level code splitting) and is offered as a follow-up, not part of this fix.

## Verification
1. `npm run build` — confirm no chunk-size warning, inspect new chunk sizes.
2. Expected post-build: `firebase-firestore` ~500-550 kB (under 700 limit, no warning), `firebase-core` small, `radix-ui` ~250-280 kB, `vendor` ~100-150 kB, `main` shrinks to ~150-200 kB (app code only).
3. `npm run lint` + `npx tsc --noEmit` — config-only change, should be clean.
4. Smoke-test `npm run dev` + `npm run preview` — confirm app loads, login works, clock screen renders (firebase-core+firestore load correctly as separate chunks).
5. No test changes needed (build config only).

## Files touched
- `vite.config.js` — `build.rollupOptions.output.manualChunks` (function form) + `build.chunkSizeWarningLimit`.

## Out of scope
- Removing unused deps (MUI, @emotion, motion, embla, react-slick, react-dnd, react-popper, @popperjs/core, next-themes, input-otp, cmdk, vaul, react-day-picker, react-responsive-masonry, react-resizable-panels) — separate cleanup, would shrink `vendor`/install size but not the warning.
- Route-level code splitting (optional item #3 above).
