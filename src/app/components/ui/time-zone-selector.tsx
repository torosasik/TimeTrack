import { Globe, LocateFixed } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from './select';
import { AUTO_TIMEZONE, DISPLAY_TIMEZONES, getOSTimezone } from '../../lib/timezones';

interface TimeZoneSelectorProps {
  value: string;
  onChange: (tz: string) => void;
}

/**
 * Time zone selector for the header.
 *
 * - An "Auto" option sits at the top of the list and is the default. It tracks
 *   the OS/device timezone (re-resolved on each load), so traveling users who
 *   update their device clock see local time without re-selecting. Selecting
 *   any other option is treated as a manual override.
 * - Changing the value persists the resolved IANA zone to the employee's
 *   `users/{uid}.timezone` (via the parent handler in App.tsx), which drives
 *   entry doc ids, the local-midnight split, week boundaries, and per-local-
 *   date totals. In "Auto" mode the OS zone is synced on load when it differs
 *   from the stored value.
 *
 * The collapsed trigger shows ONLY the UTC offset (e.g. "UTC-08:00") — or
 * "Auto" when auto is selected — to keep it narrow next to the avatar. The
 * expanded popover is widened so the full city/region list stays readable.
 */
export function TimeZoneSelector({ value, onChange }: TimeZoneSelectorProps) {
  const isAuto = value === AUTO_TIMEZONE;
  const selected = DISPLAY_TIMEZONES.find((tz) => tz.id === value);
  const detectedTZ = getOSTimezone();

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label="Display time zone"
        size="sm"
        className="h-9 md:h-10 w-[150px] sm:w-[160px] rounded-full border-slate-200 bg-white/50 text-slate-700 hover:bg-white hover:text-slate-900 text-xs md:text-sm font-medium shadow-sm px-3 md:px-4"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <Globe className="size-3.5 md:size-4 shrink-0 text-indigo-500" />
          <span className="tabular-nums truncate">
            {isAuto ? 'Auto' : (selected?.offset ?? 'UTC')}
          </span>
        </span>
      </SelectTrigger>
      <SelectContent className="w-[340px] max-w-[90vw]" position="popper" sideOffset={8}>
        <SelectItem value={AUTO_TIMEZONE}>
          <span className="flex items-center gap-1.5 font-medium">
            <LocateFixed className="size-3.5 text-indigo-500" />
            Auto
          </span>{' '}
          <span className="text-muted-foreground">
            (OS timezone: {detectedTZ})
          </span>
        </SelectItem>
        {DISPLAY_TIMEZONES.map((tz) => (
          <SelectItem key={tz.id} value={tz.id}>
            <span className="tabular-nums font-medium">{tz.offset}</span>{' '}
            <span className="text-muted-foreground">{tz.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
