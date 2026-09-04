import { doc, getDoc } from 'firebase/firestore';
import { db } from '../app/lib/firebase';

/**
 * All system settings fields (reminders + payroll) consolidated into the
 * single `systemSettings/global` document.
 */
export interface GlobalSettings {
  enable_email_reminders: boolean;
  enable_sms_reminders: boolean;
  enable_lunch_reminder: boolean;
  enable_clockout_reminder: boolean;
  enable_longshift_reminder: boolean;
  lunch_reminder_time: string;
  clockout_reminder_time: string;
  longshift_threshold_hours: number;
  payroll_cycle_type: string;
  weekly_start_day: number;
  biweekly_start_date: string;
  monthly_start_day: number;
  locked_up_to_date: string;
  /**
   * PT YYYY-MM-DD cutoff (or '' when disabled). All time records on or before
   * this date are softly excluded from analysis, metrics, payroll summaries,
   * audit, and corrections views. The raw documents remain intact in
   * Firestore — this is a reporting concern, not a data mutation.
   */
  exclude_records_before_date: string;
  // --- Automated Actions (runaway guardrails) -----------------------------
  /** Latest local time an on-site shift may remain open before auto-close. */
  onsiteLatestAllowedTime: string;
  /** The clockOut timestamp RECORDED when the on-site cutoff is reached. */
  onsiteRecordedTime: string;
  /** Max minutes an on-site lunch may stay open before auto-ending. */
  onsiteLunchMaxMinutes: number;
  /** The lunch duration RECORDED when the max is hit (lunchIn = lunchOut + this). */
  onsiteLunchRecordedMinutes: number;
  /** Max hours a remote shift may remain open before forced termination. */
  remoteMaxWorkHours: number;
}

export const DEFAULT_SETTINGS: GlobalSettings = {
  enable_email_reminders: true,
  enable_sms_reminders: false,
  enable_lunch_reminder: true,
  enable_clockout_reminder: true,
  enable_longshift_reminder: true,
  lunch_reminder_time: '15:00',
  clockout_reminder_time: '18:00',
  longshift_threshold_hours: 10,
  payroll_cycle_type: 'biweekly',
  weekly_start_day: 1,
  biweekly_start_date: '2024-01-01',
  monthly_start_day: 1,
  locked_up_to_date: '',
  exclude_records_before_date: '',
  onsiteLatestAllowedTime: '22:00',
  onsiteRecordedTime: '17:00',
  onsiteLunchMaxMinutes: 120,
  onsiteLunchRecordedMinutes: 60,
  remoteMaxWorkHours: 12,
};

/**
 * Read consolidated system settings from `systemSettings/global`.
 *
 * Read-through fallback for the single-document migration: if `global` does
 * not yet exist (i.e. the migration to the consolidated doc has not run and
 * no admin has saved since), fall back to the legacy split documents
 * `systemSettings/reminders` + `systemSettings/payroll` and merge their
 * fields. This prevents a silent reversion to hardcoded defaults during the
 * deployment window — configured reminder times / SMS opt-in / long-shift
 * threshold / payroll cycle / lock date keep working until the first save
 * writes `global`, at which point this fallback becomes dead code.
 *
 * Returns null only when NO settings doc exists anywhere (fresh install).
 */
export async function fetchGlobalSettings(): Promise<GlobalSettings | null> {
  const globalSnap = await getDoc(doc(db, 'systemSettings', 'global'));
  if (globalSnap.exists()) {
    return mapSettings(globalSnap.data());
  }

  // Legacy read-through: global not yet present. Merge the old split docs.
  const [remindersSnap, payrollSnap] = await Promise.all([
    getDoc(doc(db, 'systemSettings', 'reminders')),
    getDoc(doc(db, 'systemSettings', 'payroll')),
  ]);
  if (!remindersSnap.exists() && !payrollSnap.exists()) {
    return null;
  }
  const merged = {
    ...(remindersSnap.data() || {}),
    ...(payrollSnap.data() || {}),
  };
  return mapSettings(merged);
}

function mapSettings(data: Record<string, unknown>): GlobalSettings {
  return {
    enable_email_reminders: data.enable_email_reminders !== false,
    enable_sms_reminders: data.enable_sms_reminders === true,
    // Per-reminder enable flags default to true (missing field = enabled) so
    // legacy docs that predate these fields keep reminders on.
    enable_lunch_reminder: data.enable_lunch_reminder !== false,
    enable_clockout_reminder: data.enable_clockout_reminder !== false,
    enable_longshift_reminder: data.enable_longshift_reminder !== false,
    lunch_reminder_time: (data.lunch_reminder_time as string) || DEFAULT_SETTINGS.lunch_reminder_time,
    clockout_reminder_time: (data.clockout_reminder_time as string) || DEFAULT_SETTINGS.clockout_reminder_time,
    longshift_threshold_hours: (data.longshift_threshold_hours as number) ?? DEFAULT_SETTINGS.longshift_threshold_hours,
    payroll_cycle_type: (data.payroll_cycle_type as string) || DEFAULT_SETTINGS.payroll_cycle_type,
    weekly_start_day: (data.weekly_start_day as number) ?? DEFAULT_SETTINGS.weekly_start_day,
    biweekly_start_date: (data.biweekly_start_date as string) || DEFAULT_SETTINGS.biweekly_start_date,
    monthly_start_day: (data.monthly_start_day as number) ?? DEFAULT_SETTINGS.monthly_start_day,
    locked_up_to_date: (data.locked_up_to_date as string) || DEFAULT_SETTINGS.locked_up_to_date,
    exclude_records_before_date: (data.exclude_records_before_date as string) || DEFAULT_SETTINGS.exclude_records_before_date,
    onsiteLatestAllowedTime: (data.onsiteLatestAllowedTime as string) || DEFAULT_SETTINGS.onsiteLatestAllowedTime,
    onsiteRecordedTime: (data.onsiteRecordedTime as string) || DEFAULT_SETTINGS.onsiteRecordedTime,
    onsiteLunchMaxMinutes: (data.onsiteLunchMaxMinutes as number) ?? DEFAULT_SETTINGS.onsiteLunchMaxMinutes,
    onsiteLunchRecordedMinutes: (data.onsiteLunchRecordedMinutes as number) ?? DEFAULT_SETTINGS.onsiteLunchRecordedMinutes,
    remoteMaxWorkHours: (data.remoteMaxWorkHours as number) ?? DEFAULT_SETTINGS.remoteMaxWorkHours,
  };
}

// Guardrail limits type/defaults/resolver live in the PURE utils module so
// shiftGuardrails.ts stays Firebase-free (jest-safe). Re-exported here for
// the UI consumers that already work with this service.
export {
  DEFAULT_GUARDRAIL_LIMITS,
  resolveGuardrailLimits,
  type GuardrailLimits,
} from '../utils/guardrailLimits';
