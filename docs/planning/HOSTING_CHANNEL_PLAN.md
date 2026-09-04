# Firebase Hosting Preview Channels Plan (TimeTrack)

**Date:** 2026-05-25

## Preferred Long-Term Approach

**Dedicated staging Firebase project** (`atd-time-tracking-staging`) + explicit `--project staging` deploys (or `firebase use staging`).

This gives complete isolation for data, rules, auth users, and hosting.

All documentation and scripts added in this PR assume the dedicated staging project model.

---

## Secondary / Complementary Option: Hosting Preview Channels

Firebase Hosting supports **preview channels** (also called "deploy previews" or "channel deploys").

### Benefits
- Extremely low risk — deploys only affect a temporary URL, never the "live" site of the project (even if that project is the production one).
- Fast iteration for UI/UX validation.
- Automatic expiration (you choose `--expires`).
- No need for a second project just for quick smoke tests.

### Example Usage (once CLI is authenticated)

```bash
# From the infra/staging-firebase-setup branch or main after merge
npm run build
firebase hosting:channel:deploy phase1-staging-2026-05-25 \
  --expires 3d \
  --project staging          # or the production project ID if you are only testing UI
```

Resulting URL example:
`https://atd-time-tracking--phase1-staging-2026-05-25.web.app`

You can promote a channel to the live site later with:
`firebase hosting:clone <channel> live --project staging`

---

## When to Use Channels vs Dedicated Staging Project

| Scenario | Recommended | Reason |
|----------|-------------|--------|
| Full end-to-end validation (rules, auth, seeded users, audit logs, corrections) | Dedicated staging project | Needs its own Firestore data + rules enforcement + test users |
| Quick UI / responsive / mobile layout check after a frontend-only change | Hosting channel (even on prod project) | Zero risk to live data or rules |
| Testing Firestore security rules changes | Dedicated staging project (or emulator) | Channels only affect hosting, not Firestore rules |
| Owner wants to approve a release candidate before production | Dedicated staging project + final channel on prod project as last gate | Belt + suspenders |

---

## Safety Rules (Non-Negotiable)

- **Never** run a channel deploy or any deploy against the production project alias without explicit owner sign-off for that specific action.
- Always include `--project staging` (or `firebase use staging`) when the intent is staging validation.
- Channels created on the production project must be short-lived and clearly named (include date + purpose).
- After validation, delete the channel if it is no longer needed:
  `firebase hosting:channel:delete <channel-id> --project staging`

---

## Integration with Future CI/CD

When a GitHub Actions or similar pipeline is added later, the recommended flow is:

1. On PRs to main: automatically deploy a preview channel from the PR branch (using the staging alias or a dedicated preview project).
2. On merge to main: deploy to the "live" site of the staging project.
3. Manual production deploy only after owner approval + staging green.

The scripts and `.firebaserc` template added in this PR are the foundation for that future automation.

---

## Current Status (After This PR)

- The repository now contains clear documentation and a Hosting channel example.
- The primary path documented is still the dedicated staging project.
- No channel has been created yet (requires `firebase login` + project alias first).

**Production deploy via any method (channel promote or direct) remains blocked until owner approval.**

---

*This plan is informational only. No deploys were executed.*
