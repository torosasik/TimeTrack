// Timezone options + helpers for the header selector.
//
// The header TimeZoneSelector is the employee's control over their
// `user.timezone` (persisted to Firestore via dbService.updateUser): selecting
// a concrete zone writes that IANA id, and "Auto" follows the OS timezone
// (synced on load). The stored `user.timezone` then drives entry doc ids,
// the local-midnight split, week boundaries, and per-local-date totals
// (.kilo/rules/timezone-enforcement.md). Admin payroll controls (Lock
// Payroll Period, Exclude Records, OT buckets) remain in America/Los_Angeles.

export interface TimeZoneOption {
  /** IANA timezone id used for Intl.DateTimeFormat formatting (handles DST). */
  id: string;
  /** UTC offset prefix, e.g. "UTC-08:00" (no parentheses). Shown in the trigger. */
  offset: string;
  /** Descriptive label (cities/regions) shown in the expanded dropdown after the offset. */
  label: string;
}

/**
 * Sentinel value for the "Auto" option. When selected, the display timezone
 * tracks the OS/device timezone via `Intl.DateTimeFormat().resolvedOptions()
 * .timeZone` and is re-resolved on each render/load, so traveling users who
 * update their device clock see the local time without re-selecting. The
 * sentinel itself is what gets persisted (not the resolved id), so a stored
 * "auto" always follows the current OS TZ rather than freezing it.
 */
export const AUTO_TIMEZONE = 'auto';

// A standard worldwide selection of major time zones. Offset shown is the
// standard (base) offset; the live clock via Intl handles DST automatically.
// No "Auto" / "Detect" option is included by design (manual selection only).
// Parentheses around the UTC offset are intentionally removed; city/country
// parentheticals (e.g. "(US and Canada)") are preserved.
export const DISPLAY_TIMEZONES: TimeZoneOption[] = [
  { id: 'America/Los_Angeles', offset: 'UTC-08:00', label: 'Pacific Time (US and Canada)' },
  { id: 'America/Denver', offset: 'UTC-07:00', label: 'Mountain Time (US and Canada)' },
  { id: 'America/Chicago', offset: 'UTC-06:00', label: 'Central Time (US and Canada)' },
  { id: 'America/Mexico_City', offset: 'UTC-06:00', label: 'Mexico City' },
  { id: 'America/New_York', offset: 'UTC-05:00', label: 'Eastern Time (US and Canada)' },
  { id: 'America/Sao_Paulo', offset: 'UTC-03:00', label: 'Brasilia' },
  { id: 'America/Argentina/Buenos_Aires', offset: 'UTC-03:00', label: 'Buenos Aires' },
  { id: 'Atlantic/South_Georgia', offset: 'UTC-02:00', label: 'Mid-Atlantic' },
  { id: 'Atlantic/Azores', offset: 'UTC-01:00', label: 'Azores' },
  { id: 'Europe/London', offset: 'UTC+00:00', label: 'Dublin, Lisbon, London' },
  { id: 'Europe/Berlin', offset: 'UTC+01:00', label: 'Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna' },
  { id: 'Europe/Kyiv', offset: 'UTC+02:00', label: 'Helsinki, Kyiv, Riga, Sofia, Tallinn, Vilnius' },
  { id: 'Europe/Istanbul', offset: 'UTC+03:00', label: 'İstanbul, Moscow, St. Petersburg' },
  { id: 'Asia/Tehran', offset: 'UTC+03:30', label: 'Tehran' },
  { id: 'Asia/Dubai', offset: 'UTC+04:00', label: 'Abu Dhabi, Muscat' },
  { id: 'Asia/Kabul', offset: 'UTC+04:30', label: 'Kabul' },
  { id: 'Asia/Karachi', offset: 'UTC+05:00', label: 'Islamabad, Karachi' },
  { id: 'Asia/Kolkata', offset: 'UTC+05:30', label: 'Chennai, Kolkata, Mumbai, New Delhi' },
  { id: 'Asia/Kathmandu', offset: 'UTC+05:45', label: 'Kathmandu' },
  { id: 'Asia/Dhaka', offset: 'UTC+06:00', label: 'Astana, Dhaka' },
  { id: 'Asia/Bangkok', offset: 'UTC+07:00', label: 'Bangkok, Hanoi, Jakarta' },
  { id: 'Asia/Shanghai', offset: 'UTC+08:00', label: 'Beijing, Chongqing, Hong Kong, Urumqi' },
  { id: 'Asia/Tokyo', offset: 'UTC+09:00', label: 'Osaka, Sapporo, Tokyo' },
  { id: 'Australia/Adelaide', offset: 'UTC+09:30', label: 'Adelaide' },
  { id: 'Australia/Sydney', offset: 'UTC+10:00', label: 'Canberra, Melbourne, Sydney' },
  { id: 'Pacific/Auckland', offset: 'UTC+12:00', label: 'Auckland, Wellington' },
];

export const DEFAULT_DISPLAY_TIMEZONE = AUTO_TIMEZONE;

export interface DisplayClock {
  date: string; // YYYY-MM-DD in the selected display zone
  time: string; // HH:MM (24h) in the selected display zone
  zoneName: string; // IANA zone id (resolved — never the 'auto' sentinel)
}

/**
 * Read the OS/device timezone via Intl. Returns a valid IANA id, or
 * 'America/Los_Angeles' as a safe fallback if Intl is unavailable or returns
 * nothing (extremely rare in browser runtimes). This is DISPLAY-ONLY and does
 * not affect the canonical PT payroll timezone (AGENTS.md §2).
 */
export function getOSTimezone(): string {
  try {
    const tz =
      Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone ||
      Intl?.DateTimeFormat([], {})?.resolvedOptions?.().timeZone;
    if (tz && typeof tz === 'string') return tz;
  } catch {
    // fall through to default
  }
  return 'America/Los_Angeles';
}

/**
 * Resolve a display-timezone value to a concrete IANA id. The 'auto' sentinel
 * resolves to the current OS timezone (re-read each call, so it follows device
 * TZ changes on reload). Any other value is returned as-is (assumed to already
 * be a valid IANA id from DISPLAY_TIMEZONES).
 */
export function resolveDisplayTimezone(value: string): string {
  return value === AUTO_TIMEZONE ? getOSTimezone() : value;
}

/**
 * Format an epoch-millis instant as YYYY-MM-DD HH:MM (24h) in the given zone,
 * for DISPLAY ONLY. Accepts the 'auto' sentinel (resolved to the OS TZ) or a
 * concrete IANA id. Used for the "Since" timestamp so the same start instant
 * can be shown in both the selected display zone and canonical PT without
 * affecting stored data or calculations (AGENTS.md §2).
 */
export function formatInstantHHMM(epochMs: number, timeZone: string): string {
  const resolved = resolveDisplayTimezone(timeZone);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolved,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: resolved,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
  return `${date} ${time}`;
}

/**
 * Decide what concrete IANA zone (if any) should be persisted to the user
 * profile based on the header selector's current value. Used by the timezone
 * sync wiring (manual selection + auto-detection on load) so the employee's
 * `user.timezone` — which drives entry doc ids, the local-midnight split,
 * week boundaries, and per-local-date totals — stays in lockstep with their
 * selector / device.
 *
 * - A concrete selection (e.g. "Europe/Istanbul") is persisted as-is.
 * - The 'auto' sentinel resolves to the current OS timezone (re-read each
 *   call, so it follows device TZ changes).
 * - Returns `null` when the resolved zone already matches the stored value
 *   (no Firestore write needed), or when the resolved zone is empty.
 */
export function timezoneToPersist(
  selectorValue: string,
  storedTimezone: string | undefined,
): string | null {
  const concrete = resolveDisplayTimezone(selectorValue);
  if (!concrete) return null;
  if (concrete === storedTimezone) return null;
  return concrete;
}

/**
 * Compute the current date/time strings for the given zone.
 * Accepts either the 'auto' sentinel (resolved to the OS TZ) or a concrete
 * IANA id. Reads the live instant (new Date()) and formats via
 * Intl.DateTimeFormat. Mirrors the PT helpers' format (en-CA date, en-US 24h
 * time) so the visual style stays consistent.
 */
export function getDisplayClock(timeZone: string): DisplayClock {
  const resolved = resolveDisplayTimezone(timeZone);
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolved,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: resolved,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return { date, time, zoneName: resolved };
}
