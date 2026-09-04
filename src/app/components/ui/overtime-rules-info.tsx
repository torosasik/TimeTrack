import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './popover';
import { Button } from './button';

interface OvertimeRulesInfoProps {
  /**
   * When true, appends the Analytics-specific note about open shifts being
   * projected in-memory (not persisted to the database). Only the Analytics
   * tab surfaces this caveat; PayrollReports omits it.
   */
  includeOpenShiftsNote?: boolean;
}

/**
 * OvertimeRulesInfo — an info icon that opens a popover explaining the
 * California overtime rules applied to On-site employees.
 *
 * Replaces the legacy inline "California Overtime Rules Applied for On-site
 * Employees" banner that used to render at the bottom of the Payroll and
 * Analytics tabs. Uses the same Popover primitive as SectionHelp, so
 * Escape-key and outside-click dismissal are handled by Radix.
 */
export function OvertimeRulesInfo({ includeOpenShiftsNote = false }: OvertimeRulesInfoProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 rounded-full text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
          aria-label="California Overtime Rules"
        >
          <AlertCircle className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 shadow-lg border border-slate-200 bg-white rounded-xl p-0 overflow-hidden"
        align="end"
        sideOffset={4}
      >
        {/* Header */}
        <div className="bg-indigo-50 border-b border-indigo-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-indigo-900 flex items-center gap-2">
            <AlertCircle className="size-4 text-indigo-500 flex-shrink-0" />
            California Overtime Rules Applied for On-site Employees
          </h3>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-1">
          <p className="text-sm text-slate-600 leading-relaxed">
            • <strong>Regular:</strong> First 8 hours per day, up to 40 per week
          </p>
          <p className="text-sm text-slate-600 leading-relaxed">
            • <strong>Overtime (1.5x):</strong> Hours 8-12 per day, or over 40 per week
          </p>
          <p className="text-sm text-slate-600 leading-relaxed">
            • <strong>Double Time (2x):</strong> Over 12 hours per day
          </p>
          {includeOpenShiftsNote && (
            <p className="text-sm text-slate-600 leading-relaxed">
              • <strong>Open shifts:</strong> Still-active shifts are included with hours projected to the current moment (in-memory only; the database is not modified)
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
