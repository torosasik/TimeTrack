# TimeTrack - AI Agent Instructions

Welcome to the **TimeTrack** codebase. This document helps AI agents understand the project structure, conventions, and operational requirements.

## 🚀 Quick References

- **Primary Stack**: React (Vite), Firebase (Auth, Firestore, Hosting), Tailwind CSS.
- **Core Domain**: Employee attendance and HR records only. No client billing or project budgeting.
- **Timezone Architecture**: Dual-zone by role. **Employee workflows** (clock in/out, entry doc ids `${uid}_${date}`, week boundaries, banners, work history, time adjustments) run in the **employee's local timezone** (`user.timezone`, persisted; falls back to OS zone). **Admin controls** (payroll math, Lock Payroll Period, Exclude Records From Analysis, overtime buckets) run in **California time `America/Los_Angeles` (PT)**. Epoch-millis system timestamps (`clockInSystem`/`clockOutSystem`) are the single source of truth for instants; manual `HH:MM` strings are stored in the employee's local wall clock. Admin/Manager analysis views convert epoch timestamps to local or PT via the view toggle (`src/utils/timeView.ts`).

## 🛠 Commands

| Action | Command |
| :--- | :--- |
| **Development** | `npm run dev` (also `npm start`) |
| **Build** | `npm run build` |
| **Lint** | `npm run lint` |
| **Test (Jest)** | `npm run test` |
| **Test (Firestore Rules)** | `npm run test:rules` |
| **Seed Test Users** | `npm run seed:test-users` |
| **Seed Prod Test Users** | `npm run seed:prod-test-users` |
| **Deploy** | `firebase deploy` (CLI installed globally) |
| **Deploy rules only** | `firebase deploy --only firestore:rules,firestore:indexes` |

## 🏗 Architecture & Conventions

### 1. Project Organization
- `src/app/components/`: Component hierarchy split by role (`admin/`, `employee/`, `manager/`) and `ui/` for shared Radix-based components.
- `src/services/`: Core business logic (auth, import/export).
- `src/utils/`: Critical calculation helpers (overtime, time strings, date helpers).
- `docs/`: Master documentation. **Read before large changes.**

### 2. Guardrails (Non-Negotiable)
- **Timezone Integrity**: Never use browser `Date`/`new Date().toISOString()` directly for any value that affects pay or an entry's calendar date. Employee-facing dates/times use the employee's local zone via helpers in `src/utils/timeCalculations.ts` (`getLocalDate`, `getEmployeeTimezone`, `getLocalTimeHHMM`) and local-midnight splitting via `src/utils/midnightSplit.ts`. Admin payroll controls (Lock Payroll Period, Exclude Records From Analysis, OT buckets) stay in `America/Los_Angeles` via `src/utils/dateHelpers.js` / `src/utils/timeView.ts`.
- **Soft Deletions**: Never call `.delete()` on Firestore documents. Use `status: 'voided' | 'archived'`.
- **Audit Requirement**: Every correction to a time record must produce an immutable entry in the `auditLogs` collection. A human-provided `reason` is **mandatory for employee self-edits** (≤24h Quick Edit path) but **optional for admin/manager-initiated corrections** (policy change 2026-08: admin edits may have an empty reason; the audit row is still written).
- **Role-Based Access**: Permissions are enforced via `src/utils/permissions.js` and `firestore.rules`.
- **California Overtime**: Calculations follow specific CA rules (8h daily OT, 12h daily DT, 40h weekly OT). See [overtimeCalculations.ts](src/utils/overtimeCalculations.ts).

### 3. Key Files to Refer To
- [ARCHITECTURE_PLAN.md](docs/planning/ARCHITECTURE_PLAN.md): High-level system design.
- [FIREBASE_DATA_MODEL.md](docs/planning/FIRESTORE_DATA_MODEL.md): Canonical collection shapes and indexes.
- [SECURITY_RULES_PLAN.md](docs/planning/SECURITY_RULES_PLAN.md): Security and RBAC principles.
- [overtimeCalculations.ts](src/utils/overtimeCalculations.ts): Logic for California overtime.
- [timeCalculations.ts](src/utils/timeCalculations.ts): Total hours, segment math, employee-local date/time helpers (`getLocalDate`, `getEmployeeTimezone`, `formatInstantLocalHHMMAbbr`).
- [midnightSplit.ts](src/utils/midnightSplit.ts): Automatic local-midnight shift splitting and per-local-date totals.
- [timeView.ts](src/utils/timeView.ts): Admin local/PT display conversion from epoch timestamps.
- [dateHelpers.js](src/utils/dateHelpers.js): Centralized PT conversion logic.

## ⚠️ Pitfalls
- **Split-Shift Segments**: Time entries use a `segments[]` model to handle lunch breaks and multiple sessions. Ensure logic handles arrays of segments.
- **Firestore Rules**: Changing Firestore structure often requires updating `firestore.rules`. Always run `npm run test:rules` after such changes.
- **Vite/Tailwind**: Uses Tailwind v4 with the `@tailwindcss/vite` plugin. CSS is managed in `src/app/styles/`.
- **Firebase Initialization**: Firebase is initialized in `src/lib/firebase.ts` using config from `src/config/firebase.config.js`. Proxy exports in `src/firebase.js` (legacy) may still exist.
- **Dragme Integration**: `src/services/dragmeService.ts` is an optional external task-sync service. Requires `VITE_DRAGME_API_URL` and `VITE_DRAGME_API_KEY` env vars. All methods silently no-op when unconfigured — do not add hard failures.
- **Linting**: `eslint.config.mjs` uses flat config (ESLint v9). Run `npm run lint` before commits.

## 🤖 Kilo Code Agent Manager & Continuous Work (2026)

This project is developed primarily through **Kilo Code's Agent Manager** using isolated git worktrees, parallel sessions, and role-specialized agents. The patterns below make long-running, high-quality, multi-agent work repeatable and safe.

### Model Strategy (Role-Based)
- **Manager / Orchestrator / Architect / Planner / Reviewer / Debug**: `anthropic/claude-opus-4.7` (or `kilo-auto/frontier`).
- **Implementation workers** (`code` / `build` / `explore`): `anthropic/claude-sonnet-4.6` (default) or `google/gemini-3.1-pro` for large-context work.
- **Parallel experiments** (Multi-Version Mode): Mix Opus (1) + Sonnet (1) + Gemini 3.1 Pro (1) + DeepSeek V4 Pro (1). Use the diff panel to choose the winner.
- **Budget / high-volume / test generation**: `deepseek/deepseek-v4-pro` or Flash variants.
- Full details and cost guidelines live in `.kilo/MODEL_STRATEGY.md`.

### Required Personas
Always load the project personas when starting serious work:
- `reviewer` — Read-only, blocks any violation of AGENTS.md (timezone, audit, segments, overtime).
- `planner` — Produces plans in `.kilo/plans/`. Never writes source code.
- `doc-agent` — Maintains CHANGELOG, planning docs, and AGENTS.md.
- `payroll-guardian` — Domain expert for overtime math, `segments[]`, and audit invariants.

These live in `.kilo/personas/`. Reference them explicitly in prompts or via the sidebar model/persona picker.

### Worktree & Agent Manager Etiquette
- Every significant feature or risky refactor **MUST** be done in its own git worktree via Agent Manager (never directly on main or a shared branch).
- Use **Sections** in the Agent Manager sidebar to organize parallel streams (Payroll Core, HR Features, Admin & Audit, Security & Rules, Infra).
- The manager agent owns coordination artifacts (`PROJECT_AGENT_PLAN.md`, `WORKTREE_ASSIGNMENTS.md`, `MERGE_ORDER.md`) and is the only one allowed to propose cross-worktree file ownership changes.
- **Merge order is sacred** — follow the documented sequence. Never "merge everything at once."
- Every agent output must explicitly reference at least one rule from `AGENTS.md` (or the injected `.kilo/rules/*.md` files).
- Use the built-in `setup-script` and `run-script` (in `.kilo/`) — they copy env files, run `npm install`, start the dev server with worktree-aware ports, etc.

### Continuous / Multi-Day Work Patterns
- Start a long-running session (e.g. "implement full leave approval flow + payroll export impact") in a dedicated worktree.
- Close VS Code when pausing — the session state persists.
- Resume later. Gemini's thought preservation and Claude Opus 4.7's "dreaming" (cross-session memory) help maintain continuity.
- For true background agents spanning days/weeks, consider moving orchestration to Gemini Enterprise Agent Platform + Agent Executor while continuing to use Kilo for IDE-centric planning and review.

### Automation You Must Use
- `.kilo/setup-script` — Runs automatically on new worktree creation.
- `.kilo/run-script` — Starts the Vite dev server (and optionally emulators) for that worktree.
- `.kilo/rules/*.md` — Short injectable guardrails (timezone, mandatory audit reason for employees, soft-delete + segments). Add these to your `instructions` array in global or project config.

### Persistence & Recovery (Do Not Lose Your Setup Again)
All real configuration lives in `.kilo/` and **must be committed to git**:

- `kilo.json`
- `personas/`
- `rules/`
- `setup-script` + `run-script`
- `MODEL_STRATEGY.md`
- `README.md` (recovery instructions)
- Important shared plans

Transient state (`agent-manager.json`, `worktrees/`, `node_modules/`) is correctly gitignored.

**After Kilo Code extension reinstall, removal, or opening on a new machine:**
1. Pull latest code (the `.kilo/` config must be present).
2. Open the folder in VS Code + install the extension.
3. Everything (personas, rules, scripts, model strategy) reloads automatically from the committed files.

See `.kilo/README.md` for the full recovery process. This is the only reliable way to survive what happened to you before.

### Verification
After any batch of agent-driven changes, re-run:
```bash
npm run lint
npm run test
npm run test:rules   # if firestore.rules were touched
```
The code-skeptic custom agent (defined in `.kilo/kilo.json`) is available to act as an independent critical reviewer on any claim that "everything is good."

**This section exists because the team has already successfully used sophisticated multi-agent worktree workflows (see `.kilo/plans/1779682548059-brave-garden.md` and the various feature/* and architecture/* worktrees). These rules make that style of development the default, safe, and cost-effective way to build TimeTrack.**

## 📚 Documentation Index
- [Onboarding Runbook](docs/guides/ONBOARDING_RUNBOOK.md)
- [California Overtime Guide](docs/guides/CALIFORNIA_OVERTIME_SYSTEM.md)
- [Testing Guide](docs/testing/TESTING_GUIDE.md)
- [Deployment Guide](docs/deployment/DEPLOYMENT_GUIDE.md)
