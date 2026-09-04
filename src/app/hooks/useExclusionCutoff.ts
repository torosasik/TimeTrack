import { useEffect, useState } from 'react';
import { fetchGlobalSettings } from '../../services/systemSettingsService';

/**
 * Loads the global "exclude records before date" cutoff once on mount.
 *
 * There is no shared settings context in this app — each analysis tab fetches
 * system settings independently. This hook centralizes that fetch so every
 * analysis tab reads the same exclusion cutoff without duplicating the
 * load/mapping logic. Returns `''` (filter disabled) until settings load or if
 * the fetch fails, so views remain fully inclusive by default.
 */
export function useExclusionCutoff(): string {
  const [cutoff, setCutoff] = useState('');
  useEffect(() => {
    let active = true;
    fetchGlobalSettings()
      .then(s => {
        if (active && s) setCutoff(s.exclude_records_before_date || '');
      })
      .catch(() => {
        // Inclusive fallback — never block records because settings failed to load.
      });
    return () => {
      active = false;
    };
  }, []);
  return cutoff;
}
