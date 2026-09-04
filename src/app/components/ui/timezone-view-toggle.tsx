import { Globe, Sun } from 'lucide-react';
import { Button } from './button';
import type { TimeViewMode } from '../../../utils/timeView';

interface TimezoneViewToggleProps {
  mode: TimeViewMode;
  onChange: (mode: TimeViewMode) => void;
}

/**
 * Admin/Manager timezone view toggle (Req 4).
 *
 *   [ View in Local Time ] | [ View in California Time (PT) ]
 *
 * - "local": shift times rendered as worked in the employee's local timezone
 *   (the default).
 * - "pt":    shift times dynamically converted to America/Los_Angeles (PT)
 *   for administrative review.
 *
 * Purely presentational — the conversion happens via the epoch system
 * timestamps in `utils/timeView.ts`; stored data is untouched.
 */
export function TimezoneViewToggle({ mode, onChange }: TimezoneViewToggleProps) {
  return (
    <div
      role="group"
      aria-label="Timezone view"
      className="inline-flex items-center gap-1 rounded-xl border border-indigo-100 bg-indigo-50/50 p-1 shadow-sm"
    >
      <Button
        type="button"
        size="sm"
        variant={mode === 'local' ? 'default' : 'ghost'}
        onClick={() => onChange('local')}
        aria-pressed={mode === 'local'}
        className={`h-9 rounded-lg text-xs md:text-sm font-medium transition-all ${
          mode === 'local'
            ? 'bg-indigo-600 text-white shadow-md hover:bg-indigo-600'
            : 'text-slate-600 hover:bg-white/60'
        }`}
      >
        <Globe className="size-4 mr-1.5" />
        View in Local Time
      </Button>
      <Button
        type="button"
        size="sm"
        variant={mode === 'pt' ? 'default' : 'ghost'}
        onClick={() => onChange('pt')}
        aria-pressed={mode === 'pt'}
        className={`h-9 rounded-lg text-xs md:text-sm font-medium transition-all ${
          mode === 'pt'
            ? 'bg-indigo-600 text-white shadow-md hover:bg-indigo-600'
            : 'text-slate-600 hover:bg-white/60'
        }`}
      >
        <Sun className="size-4 mr-1.5" />
        View in California Time (PT)
      </Button>
    </div>
  );
}
