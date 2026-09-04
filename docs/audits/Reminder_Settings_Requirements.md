# Reminder Settings Requirements Audit

**Date:** 2026-07-25
**Scope:** Verification of whether the Reminder Settings feature (email + SMS notifications, scheduled reminders, and the per-reminder checkboxes surfaced in the Settings UI) is actually wired end-to-end, or whether parts are dormant / cosmetic.
**Method:** Static scan of `functions/src/` (Cloud Functions), `src/app/components/admin/SystemSettingsView.tsx` (Settings UI), Firestore env/config, and deployment artifacts. Each finding lists the exact file:line, the current behavior, and a remediation path.

---

## Summary

The reminder system is **partially built but not operational**:

- **Email:** code exists (`nodemailer`), but no SMTP credentials are configured → nothing sends.
- **SMS:** code exists (`twilio`), but no Twilio credentials are configured → nothing sends.
- **Global channel toggles** (Enable Email / Enable SMS Globally): **real** settings, read and respected by the scheduled function.
- **Reminder times + long-shift threshold:** **real** settings, read and used by the scheduled function.
- **Per-reminder enable checkboxes** (next to Lunch / Clock Out / Long Shift in the Settings UI): **cosmetic only** — no backing data field and the function has no awareness of them. They were added as a UI affordance (derived from blanking/zeroing the value) and do not represent a proper on/off flag.
- **Deployment status of the scheduled function** (`processReminders`, every 5 min): **unverifiable from here** — it is exported from `functions/src/index.ts` and structured for deploy, but there is no evidence in the repo that it has been deployed to the live Firebase project. If never deployed, none of the above runs at all.

---

## Findings

### 1. Email sending is wired but dormant (no SMTP credentials)

- **Current state:** `NotificationService.sendEmail()` (`functions/src/notifications.ts:86`) calls `nodemailer`'s `transporter.sendMail(...)`. The transporter is only initialized in `initEmail()` (`functions/src/notifications.ts:36-56`) when **both** `SMTP_USER` and `SMTP_PASS` are present.
- **Config status:** Neither env var is set anywhere:
  - Not in `.env.example` (it documents only `VITE_*` frontend vars — no SMTP entries).
  - No `.env` file containing them.
  - No `.runtimeconfig.json` (file does not exist).
  - No `functions/.env` / `functions/.env.example`.
- **Behavior when unconfigured:** `initEmail()` logs `"Email service not fully configured - Missing SMTP_USER or SMTP_PASS."` and leaves `transporter = null`. `sendEmail()` then logs `"Skipped Email to {to} - SMTP not configured."` and returns `false` without throwing (`notifications.ts:86-91`).
- **Callers:** `functions/src/reminders.ts:104,129,158` (lunch / clock-out / long-shift reminders).
- **Impact:** All three reminder emails silently no-op. No user-facing error, no delivery.
- **Recommendation:** Provision an SMTP credential set (e.g. an app-password Gmail account or a transactional provider like SendGrid/Mailgun/Resend). Set `SMTP_USER`, `SMTP_PASS`, `SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM` in the Cloud Functions runtime config (`firebase functions:secrets:set` or `firebase functions:config:set`), then redeploy. Optionally surface a "not configured" indicator in the Settings UI next to the Email toggle.

### 2. SMS sending is wired but dormant (no Twilio credentials)

- **Current state:** `NotificationService.sendSMS()` (`functions/src/notifications.ts:62`) calls `twilio.messages.create(...)`. The client is only initialized in `initTwilio()` (`functions/src/notifications.ts:17-34`) when **all three** of `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` are present.
- **Config status:** None of the three are set anywhere in the repo (same as email — no `.env`, no runtime config, no `.env.example` entries).
- **Behavior when unconfigured:** logs `"SMS disabled – Twilio not configured (Missing SID, Token, or Phone Number in ENV)"` and leaves `twilioClient = null`. `sendSMS()` then logs `"Skipped SMS to {phone} - Twilio not configured."` and returns `false` (`notifications.ts:62-67`).
- **Callers:** `functions/src/reminders.ts:108,133,162`.
- **Impact:** All three reminder SMS silently no-op.
- **Recommendation:** Provision a Twilio account + a sending number, set the three env vars via Cloud Functions secrets, redeploy. Note SMS also depends on each user's `phone_number` and `sms_opt_in` being set on their `users` doc.

### 3. Global channel toggles are real and respected

- **Fields:** `enable_email_reminders`, `enable_sms_reminders` (stored on `systemSettings/reminders`).
- **Read site:** `functions/src/reminders.ts:24-25`:
  ```ts
  const enableEmails = settings.enable_email_reminders !== false; // Default true
  const enableSMS = settings.enable_sms_reminders === true;       // Default false
  ```
- **Effect:** Each reminder branch checks these before calling `sendEmail`/`sendSMS` (see `reminders.ts:100-165`). Toggling them in the Settings UI writes through to Firestore and the next function run honors it.
- **Status:** ✅ Functional end-to-end (assuming the function is deployed and the channel credentials exist — see Findings 1 & 2).
- **UI binding:** `SystemSettingsView.tsx:132-141` (checkboxes bound to `systemSettings.enable_email_reminders` / `enable_sms_reminders`; save handler writes them at `SystemSettingsView.tsx:74-75`).

### 4. Reminder times and long-shift threshold are real and used

- **Fields:** `lunch_reminder_time`, `clockout_reminder_time`, `longshift_threshold_hours`.
- **Read site:** `functions/src/reminders.ts:26-28`:
  ```ts
  const lunchReminderTimeStr   = settings.lunch_reminder_time   || '15:00';
  const clockOutReminderTimeStr = settings.clockout_reminder_time || '18:00';
  const longShiftThreshold      = settings.longshift_threshold_hours || 10;
  ```
- **Effect:** The function parses these into `[H, M]` arrays and compares against each active employee's PT-local clock to decide whether to fire the lunch / clock-out reminders, and uses `longShiftThreshold` as the elapsed-hours trigger for the long-shift reminder (`reminders.ts:34-35` and the matching logic further down).
- **Status:** ✅ Functional (again, modulo deployment + credentials).
- **UI binding:** `SystemSettingsView.tsx:157-158, 174-175, 193-194` (time/number inputs bound to the same fields; save handler writes them at `SystemSettingsView.tsx:76-78`).

### 5. Per-reminder enable checkboxes are cosmetic (no backing field) — RECOMMEND FIX

- **What they are:** The three checkboxes added in the most recent Settings UI redesign, one beside each of "Lunch Reminder Time", "Clock Out Reminder", and "Long Shift Threshold (Hours)" (`SystemSettingsView.tsx:149-151, 167-168, 184-185`).
- **The problem:** There is **no** `enable_lunch_reminder` / `enable_clockout_reminder` / `enable_longshift` field in the Firestore `systemSettings/reminders` document, and `processReminders` reads no such field. The checkboxes were implemented as a UI-only affordance by deriving their checked state from the value:
  - Lunch/Clock-out: checked ⇔ the time string is non-empty; unchecking clears the time to `''`, re-checking restores the default (`SystemSettingsView.tsx:150-151, 167-168`).
  - Long-shift: checked ⇔ threshold is non-zero; unchecking sets it to `0` (`SystemSettingsView.tsx:184-185`).
- **Why this is wrong:**
  1. It's a hidden coupling — the "enable" and the "value" are the same field, so an admin can't disable a reminder without losing their configured time/threshold.
  2. The function (`reminders.ts:26-28`) treats `''` / `0` via `|| '15:00'` / `|| 10` defaults, so unchecking does **not** actually disable the reminder — it silently re-enables it with the default value on the next function run. The checkbox therefore misrepresents reality: it looks off, but the reminder still fires at the default time/threshold.
  3. No audit trail / config truth for per-reminder on/off state.
- **Impact:** Admins will believe they've disabled individual reminders when they have not. This is a correctness bug, not just a cosmetic gap.
- **Recommendation (preferred):** Add proper boolean fields to the data model and have the function respect them:
  - Document: add `enable_lunch_reminder`, `enable_clockout_reminder`, `enable_longshift_reminder` (default `true`) to `systemSettings/reminders`.
  - Function: in `reminders.ts`, read and short-circuit each branch before sending (e.g. `if (!settings.enable_lunch_reminder) skip lunch`).
  - UI: bind the three checkboxes to the new fields; leave the time/threshold inputs independent of the enable state.
  - Migration/backfill: a one-time script (or the function's `!== false` default pattern) can treat missing fields as `true` to stay backward-compatible with existing docs.
- **Alternative (minimal):** Revert the three per-reminder checkboxes entirely and rely only on the two global channel toggles (Email / SMS) for on/off control, which already work. This loses the per-reminder granularity but is honest about current capabilities.

### 6. Scheduled-function deployment is unverifiable

- **Artifact:** `functions/src/reminders.ts:13` — `export const processReminders = functions.pubsub.schedule('every 5 minutes').onRun(...)`. Exported via `functions/src/index.ts` (`export * from './reminders'`).
- **What can't be confirmed from the repo:** whether this function has actually been deployed to the live Firebase project (would require `firebase functions:list` / project credentials). `firebase.json` configures hosting + firestore + emulators but does **not** declare a `functions` deploy source explicitly — the deploy relies on the `functions/` directory convention.
- **Impact:** If the function has never been deployed (or was deployed but is paused), **none** of the reminder logic runs regardless of credentials/settings. The Settings UI would then be configuring values that nothing reads.
- **Recommendation:** Verify deployment (`firebase functions:list` in the project), confirm the schedule is active, and check Cloud Functions logs for the "Starting reminder evaluations..." log line (`reminders.ts:14`) to prove it's executing.

---

## Action checklist

| # | Action | Severity | Owner area |
|---|---|---|---|
| 1 | Provision + set SMTP credentials; redeploy functions | High (enables email) | Infra |
| 2 | Provision + set Twilio credentials; redeploy functions | High (enables SMS) | Infra |
| 3 | Add `enable_lunch_reminder` / `enable_clockout_reminder` / `enable_longshift_reminder` fields; teach `processReminders` to respect them; rebind the 3 UI checkboxes | High (correctness) | Backend + UI |
| 4 | Verify `processReminders` is deployed and the schedule is active | High (gating) | Infra |
| 5 | (Optional) Surface a "channel not configured" banner in Settings when SMTP/Twilio env is absent | Medium (UX honesty) | UI |

---

## Reference: file inventory

- `functions/src/notifications.ts` — `NotificationService` (nodemailer + twilio), env-gated init.
- `functions/src/reminders.ts` — `processReminders` scheduled function; reads `systemSettings/reminders`, iterates active users, fires lunch / clock-out / long-shift reminders.
- `functions/src/index.ts` — re-exports `processReminders` for deploy.
- `src/app/components/admin/SystemSettingsView.tsx` — Settings UI (reminder + payroll + lock cards). Writes to `systemSettings/reminders` and `systemSettings/payroll`.
- `firestore.rules` — not audited here; reminder docs live under `systemSettings/{reminders,payroll}`.
- `.env.example` — frontend-only (`VITE_*`); no SMTP/Twilio entries.
- No `.runtimeconfig.json`, no `functions/.env*` — credentials are not configured in-repo.
