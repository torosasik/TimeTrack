import { Clock, Coffee, TrendingUp } from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import type { TimeSegment } from '../../lib/database';
import { formatHoursHMM, formatInstantLocalHHMMAbbr } from '../../../utils/timeCalculations';
import { getDisplayClock } from '../../lib/timezones';

interface ClockStatusProps {
  isClockedIn: boolean;
  isOnLunch: boolean;
  activeSegment: TimeSegment | null;
  /** Actual WORK minutes today (excludes breaks). */
  workMinutes: number;
  /** Total BREAK minutes today (lunch durations, including in-progress). */
  breakMinutes: number;
  /**
   * IANA zone id used purely for DISPLAY of the live date/time/zone label on
   * this screen. Does not affect stored data or calculations.
   */
  displayTimezone: string;
  /**
   * IANA zone used for the "Since" banner (Req 3) — the employee's persisted
   * local timezone. Defaults to `displayTimezone` when omitted.
   */
  statusTimezone?: string;
}

export function ClockStatus({
  isClockedIn,
  isOnLunch,
  activeSegment,
  workMinutes,
  breakMinutes,
  displayTimezone,
  statusTimezone,
}: ClockStatusProps) {
  const displayClock = getDisplayClock(displayTimezone);
  const sinceZone = statusTimezone ?? displayTimezone;
  const statusColor = isOnLunch
    ? 'bg-amber-100 text-amber-800 border-amber-300'
    : isClockedIn
    ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
    : 'bg-slate-100 text-slate-600 border-slate-300';

  const statusText = isOnLunch
    ? 'ON LUNCH BREAK'
    : isClockedIn
    ? 'CLOCKED IN'
    : 'CLOCKED OUT';

  // The "Since" start instant. Prefer the system epoch (millis) so the same
  // instant can be formatted in two zones; fall back to the PT manual string
  // when system millis are absent (legacy/historical segments).
  const sinceEpoch = isOnLunch
    ? activeSegment?.lunchOutSystem
    : isClockedIn
    ? activeSegment?.clockInSystem
    : undefined;
  const sincePTManual = isOnLunch
    ? activeSegment?.lunchOutManual
    : isClockedIn
    ? activeSegment?.clockInManual
    : null;
  // displayClock.zoneName is already resolved ('auto' -> OS TZ name), so it
  // doubles as the row-1 zone label per the two-row spec.

  return (
    <Card className="w-full border-2 shadow-sm">
      <CardContent className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground font-medium">
              {displayClock.date} • {displayClock.zoneName}
            </div>
            <div className="text-5xl font-mono font-semibold tracking-tighter text-foreground tabular-nums mt-1">
              {displayClock.time}
            </div>
          </div>

          <Badge className={`text-base px-4 py-1 font-semibold border ${statusColor}`}>
            {statusText}
          </Badge>
        </div>

        {sinceEpoch ? (
          // Single-row "Since" display (Req 3): the start instant shown in the
          // employee's LOCAL timezone with the short zone abbreviation, and NO
          // date portion (e.g. "Since 10:30 PM EST").
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span>
                Since{' '}
                <span className="font-bold text-foreground tabular-nums">
                  {formatInstantLocalHHMMAbbr(sinceEpoch, sinceZone)}
                </span>
              </span>
            </div>
          </div>
        ) : sincePTManual ? (
          // Degraded fallback: no system millis — show only the local manual
          // string (can't reliably convert to another zone without the instant).
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span>
                Since{' '}
                <span className="font-bold text-foreground tabular-nums">
                  {sincePTManual}
                </span>{' '}
                {displayClock.zoneName}
              </span>
            </div>
          </div>
        ) : null}

        <div className="pt-2 border-t">
          {/* Centered header */}
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <TrendingUp className="h-4 w-4" />
            <span className="text-sm">Today so far</span>
          </div>
          {/* 3-column horizontal metrics: Work | Break | Total. Each column
              stacks its label (normal weight, no colon) above its value
              (bold), both center-aligned within the column. */}
          <div className="grid grid-cols-3 gap-2 mt-2">
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-sm text-muted-foreground">Work</span>
              <span className="text-3xl font-bold tabular-nums text-foreground">
                {formatHoursHMM(workMinutes / 60)}
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-sm text-muted-foreground">Break</span>
              <span className="text-3xl font-bold tabular-nums text-foreground">
                {formatHoursHMM(breakMinutes / 60)}
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-sm text-muted-foreground">Total</span>
              <span className="text-3xl font-bold tabular-nums text-foreground">
                {formatHoursHMM((workMinutes + breakMinutes) / 60)}
              </span>
            </div>
          </div>
        </div>

        {isOnLunch && (
          <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-sm">
            <Coffee className="h-4 w-4 flex-shrink-0" />
            <span>Lunch break in progress — tap END LUNCH when you return.</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
