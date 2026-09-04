/**
 * Soft "exclude records before date" filtering.
 *
 * A reporting-only concern: the admin sets a PT YYYY-MM-DD cutoff in the
 * "Exclude Records From Analysis" settings card. Every analysis tab (Payroll,
 * Metrics, Team, Audit, Timesheet Review, Corrections) hides records on or
 * before that date from its views/aggregates. The raw documents are never
 * mutated or deleted — this is purely a client-side read filter.
 *
 * The date fields compared here (`workDate` / `date` / `requested_date`) are
 * all PT YYYY-MM-DD strings, so a lexicographic string comparison is correct
 * and timezone-safe (no `Date` object is constructed, per the timezone rule).
 */

/**
 * True when `entryDate` (YYYY-MM-DD) falls on or before the exclusion cutoff.
 * An empty/absent cutoff disables the filter (returns false).
 */
export function isExcludedByCutoff(entryDate: string | undefined | null, cutoff: string): boolean {
  if (!cutoff) return false;
  if (!entryDate) return false;
  return entryDate <= cutoff;
}

/**
 * Drop records on or before the cutoff. Generic over the entry shape; the
 * caller provides the field key used to read each entry's date string.
 */
export function filterByExclusionCutoff<T>(
  entries: readonly T[],
  cutoff: string,
  getDate: (entry: T) => string | undefined | null,
): T[] {
  if (!cutoff) return [...entries];
  return entries.filter(e => !isExcludedByCutoff(getDate(e), cutoff));
}
