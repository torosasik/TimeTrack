/**
 * Automated Actions limits (Settings → Automated Actions) — PURE module.
 *
 * Lives outside systemSettingsService.ts on purpose: that service imports the
 * Firebase client, which would break jest (import.meta) and bloat the pure
 * guardrail decision logic in shiftGuardrails.ts. systemSettingsService
 * re-exports these for UI consumers that already fetch the settings doc.
 */

/** The five configurable automated-action limits (subset of GlobalSettings). */
export interface GuardrailLimits {
  onsiteLatestAllowedTime: string;
  onsiteRecordedTime: string;
  onsiteLunchMaxMinutes: number;
  onsiteLunchRecordedMinutes: number;
  remoteMaxWorkHours: number;
}

export const DEFAULT_GUARDRAIL_LIMITS: GuardrailLimits = {
  onsiteLatestAllowedTime: '22:00',
  onsiteRecordedTime: '17:00',
  onsiteLunchMaxMinutes: 120,
  onsiteLunchRecordedMinutes: 60,
  remoteMaxWorkHours: 12,
};

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * Resolve the active automated-action limits from a (possibly missing /
 * legacy / partial) settings object. Missing or malformed fields fall back to
 * the documented defaults so the cron / repair tool / warning banners never
 * run on undefined values during the migration window.
 */
export function resolveGuardrailLimits(
  settings?: Partial<GuardrailLimits> | null,
): GuardrailLimits {
  const s = settings ?? {};
  const num = (v: unknown, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt;
  const hhmm = (v: unknown, dflt: string): string =>
    typeof v === 'string' && HHMM_RE.test(v) ? v : dflt;
  return {
    onsiteLatestAllowedTime: hhmm(s.onsiteLatestAllowedTime, DEFAULT_GUARDRAIL_LIMITS.onsiteLatestAllowedTime),
    onsiteRecordedTime: hhmm(s.onsiteRecordedTime, DEFAULT_GUARDRAIL_LIMITS.onsiteRecordedTime),
    onsiteLunchMaxMinutes: num(s.onsiteLunchMaxMinutes, DEFAULT_GUARDRAIL_LIMITS.onsiteLunchMaxMinutes),
    onsiteLunchRecordedMinutes: num(s.onsiteLunchRecordedMinutes, DEFAULT_GUARDRAIL_LIMITS.onsiteLunchRecordedMinutes),
    remoteMaxWorkHours: num(s.remoteMaxWorkHours, DEFAULT_GUARDRAIL_LIMITS.remoteMaxWorkHours),
  };
}