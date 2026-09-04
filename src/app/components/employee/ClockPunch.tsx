import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { Clock, Coffee, LogOut, RefreshCw, CalendarDays, AlertTriangle, WifiOff } from 'lucide-react';

import type { User } from '../../lib/auth';
import { dbService } from '../../lib/database';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Textarea } from '../ui/textarea';
import { ClockStatus } from './ClockStatus';
import {
  getPunchStatus,
  punchIn,
  punchOut,
  toggleLunch,
  getWeekSummary,
  type PunchStatus,
  type WeekSummary,
} from '../../../services/clockService';
import { formatHoursHMM, getEmployeeTimezone, getTimezoneAbbreviation, getLocalDate, subtractLocalDays } from '../../../utils/timeCalculations';
import { detectGuardrailWarning } from '../../../utils/shiftGuardrails';
import { fetchGlobalSettings, resolveGuardrailLimits } from '../../../services/systemSettingsService';
import { listAllWorkModels, type WorkModel as WorkModelDef } from '../../../services/workModelsService';
import { isRemoteWorkModel } from '../../../utils/workModelUtils';

interface ClockPunchProps {
  user: User;
  onViewHistory?: () => void;
  /**
   * Display-only time zone (IANA id). Affects only the on-screen date/time/zone
   * label; never affects calculations or stored timestamps.
   */
  displayTimezone: string;
}

export function ClockPunch({ user, onViewHistory, displayTimezone }: ClockPunchProps) {
  const [status, setStatus] = useState<PunchStatus | null>(null);
  const [week, setWeek] = useState<WeekSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // Confirmation step for Lunch Out / Lunch In / Clock Out (Clock In stays
  // one-tap). Holds the pending action while the dialog is open; null = closed.
  const [confirmAction, setConfirmAction] = useState<'out' | 'lunch-out' | 'lunch-in' | null>(null);
  // Employee's persisted local timezone drives entry doc ids, the local
  // midnight split, and per-local-date totals (the local-time-tracking
  // refactor). Falls back to the OS timezone when the profile has none.
  const employeeTz = useMemo(() => getEmployeeTimezone(user.timezone), [user.timezone]);
  // Non-blocking "Action Required" warning when a recent entry was auto-closed
  // or auto-ended by the server-side guardrails. WARNING ONLY — it never blocks
  // or disables the Clock In button for a new shift.
  const [guardrailWarning, setGuardrailWarning] = useState<string | null>(null);

  // Detect any recent guardrail action (auto-closed shift / auto-ended lunch)
  // so the employee sees a warning banner. Best-effort and silent on failure —
  // the banner is advisory only and must never interfere with punching.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const today = getLocalDate(employeeTz);
        const start = subtractLocalDays(today, 7, employeeTz);
        // Fetch the active Automated Actions limits alongside the entries so
        // the banner quotes the rules that actually fired (defaults apply if
        // the settings doc is missing/unreadable — banner stays advisory).
        const [recent, settings] = await Promise.all([
          dbService.getTimeEntriesForUserInRange(user.uid, start, today),
          fetchGlobalSettings().catch(() => null),
        ]);
        if (cancelled) return;
        const detection = detectGuardrailWarning(recent, resolveGuardrailLimits(settings));
        setGuardrailWarning(detection.hasWarning ? detection.reason : null);
      } catch {
        // Silent — advisory banner only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user.uid, employeeTz]);
  // Layer 2: persistent failure banner. A fleeting toast was easy to miss on
  // a flaky mobile connection, leaving the employee believing their clock-out
  // landed when it hadn't (root cause of the stuck open shifts on
  // 06-15/06-24/06-25/07-10). This banner stays visible until the action is
  // retried successfully or dismissed, and exposes a Retry button.
  const [writeFailure, setWriteFailure] = useState<{ action: 'in' | 'out' | 'lunch'; message: string } | null>(null);
  // Synchronous guard against double-click / double-punch race conditions.
  // setState is async in React; a ref check runs synchronously on every call,
  // preventing two punch-in (or punch-out / lunch) calls from being dispatched
  // even when clicks arrive faster than the event loop.
  const punchInFlight = useRef(false);

  // Daily Report trigger: Remote employees only.
  //
  // Root-cause fix for "popup didn't appear for a Remote employee (works for
  // admin)": the authoritative workModelId → name resolution can silently
  // misclassify a Remote employee as On-site when (a) the FK points at a
  // VOIDED model — listWorkModels filters voided docs out, so the lookup can't
  // resolve the name and falls back to a stale legacy string — or (b) the
  // fetch fails, forcing the same fallback.
  //
  // Strategy:
  //   1. The employee's OWN user doc is always readable (rules: users read
  //      their own profile), so workModel/workModelId are always present.
  //   2. Legacy string says Remote → Remote, no fetch needed (standard case).
  //   3. Else use the authoritative FK → name lookup over a voided-INCLUSIVE
  //      model list (listAllWorkModels), so a voided Remote model still
  //      classifies correctly. Re-fetch once at click time if the mount fetch
  //      was dropped.
  //   4. If the list genuinely can't load, fall back to the legacy-string
  //      negative (the string was already checked in step 2). FK presence
  //      alone is NOT evidence of Remote-ness — work-model ids are opaque
  //      auto-generated doc ids — so we never show the popup to a known
  //      On-site employee just because the lookup failed.
  const [workModels, setWorkModels] = useState<WorkModelDef[]>([]);
  const [workModelsLoaded, setWorkModelsLoaded] = useState(false);
  useEffect(() => {
    listAllWorkModels()
      .then((m) => { setWorkModels(m); setWorkModelsLoaded(true); })
      .catch(e => {
        console.error('Failed to load work models for daily-report trigger', e);
        setWorkModelsLoaded(false);
      });
  }, []);

  const resolveIsRemote = async (): Promise<boolean> => {
    // Fast path: the employee's own legacy string is authoritative when it
    // already says Remote (covers the standard 'Remote' model with no fetch).
    if (String(user.workModel).toLowerCase().includes('remote')) return true;

    // Authoritative FK → name lookup over the voided-inclusive list.
    let models = workModels;
    let loaded = workModelsLoaded;
    if (!loaded) {
      // Try one fresh fetch at click time in case the mount fetch was dropped.
      try {
        models = await listAllWorkModels();
        setWorkModels(models);
        loaded = true;
        setWorkModelsLoaded(true);
      } catch {
        loaded = false;
      }
    }
    // When the list loaded, trust the SSOT. When it genuinely can't load,
    // return false (the legacy-string negative already established above).
    return loaded ? isRemoteWorkModel(user, models) : false;
  };

  // Daily Report modal (Remote clock-out). When open, clock-out is paused
  // until the employee Saves (writes the text) or Cancels (writes "").
  const [dailyReportOpen, setDailyReportOpen] = useState(false);
  const [dailyReportText, setDailyReportText] = useState('');
  const DAILY_REPORT_MAX = 250;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, w] = await Promise.all([
        getPunchStatus(user.uid, employeeTz),
        getWeekSummary(user.uid, employeeTz),
      ]);
      setStatus(s);
      setWeek(w);
    } catch (e: unknown) {
      toast.error('Failed to load punch status: ' + ((e as Error).message || String(e)));
    } finally {
      setLoading(false);
    }
  }, [user.uid, employeeTz]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // Light refresh every 60s so the live PT time and open-shift estimate stay fresh
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [load]);

  // Layer 2: notification-only open-shift watchdog. Detects a shift open >16h
  // and prompts the employee to confirm they're still on shift / clock out —
  // WITHOUT writing anything (unlike the legacy TodayEntry 12h auto-closer,
  // which audit item #1 flags as writing capped/incorrect timestamps + no
  // audit). 16h threshold exceeds a normal long day but catches genuinely
  // forgotten clock-outs (the 06-15 shift ran ~5 weeks open). Fires once per
  // open shift per session to avoid nagging.
  const watchdogFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!status?.isClockedIn || !status.activeSegment?.clockInSystem) return;
    const clockInMs = status.activeSegment.clockInSystem;
    const segKey = status.activeSegment.id || String(clockInMs);
    if (watchdogFiredRef.current === segKey) return;
    const elapsedH = (Date.now() - clockInMs) / (60 * 60 * 1000);
    if (elapsedH > 16) {
      watchdogFiredRef.current = segKey;
      toast.warning(
        `You've been clocked in for ${Math.floor(elapsedH)} hours. If you forgot to clock out, tap CLOCK OUT now.`,
        { duration: 10000 },
      );
    }
  }, [status?.isClockedIn, status?.activeSegment?.clockInSystem, status?.activeSegment?.id]);

  const requireOnline = () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      toast.error('You are offline. Connect to the internet before recording a punch.');
      return false;
    }
    return true;
  };

  const doPunchIn = async () => {
    if (!requireOnline()) return;
    if (punchInFlight.current) return;
    punchInFlight.current = true;
    setActionLoading('in');
    try {
      await punchIn(user.uid, undefined, employeeTz);
      setWriteFailure(null);
      toast.success('Clocked in — shift started');
      await load();
    } catch (e: unknown) {
      const msg = (e as Error).message || 'Could not clock in';
      toast.error(msg);
      setWriteFailure({ action: 'in', message: msg });
    } finally {
      punchInFlight.current = false;
      setActionLoading(null);
    }
  };

  const doPunchOut = async (dailyReport?: string) => {
    if (!requireOnline()) return;
    if (punchInFlight.current) return;
    punchInFlight.current = true;
    setActionLoading('out');
    try {
      await punchOut(user.uid, employeeTz, dailyReport);
      setWriteFailure(null);
      toast.success('Clocked out — shift complete');
      await load();
    } catch (e: unknown) {
      const msg = (e as Error).message || 'Could not clock out';
      toast.error(msg);
      setWriteFailure({ action: 'out', message: msg });
    } finally {
      punchInFlight.current = false;
      setActionLoading(null);
    }
  };

  const doToggleLunch = async () => {
    if (!requireOnline()) return;
    if (punchInFlight.current) return;
    punchInFlight.current = true;
    setActionLoading('lunch');
    try {
      const s = status;
      const isEnding = s?.isOnLunch;
      await toggleLunch(user.uid, false, employeeTz);
      setWriteFailure(null);
      toast.success(isEnding ? 'Lunch ended — welcome back' : 'Lunch started');
      await load();
    } catch (e: unknown) {
      const msg = (e as Error).message || 'Lunch action failed';
      toast.error(msg);
      setWriteFailure({ action: 'lunch', message: msg });
    } finally {
      punchInFlight.current = false;
      setActionLoading(null);
    }
  };

  // Dialog copy + dispatch for the three confirmable actions. Cancel simply
  // closes the dialog (confirmAction -> null) with no state mutation.
  const CONFIRM_COPY = {
    out: {
      title: 'Confirm Clock Out',
      body: 'Are you sure you want to clock out at this time?',
      confirmLabel: 'Clock Out',
    },
    'lunch-out': {
      title: 'Confirm Lunch Out',
      body: 'Are you sure you want to start your lunch break at this time?',
      confirmLabel: 'Start Lunch',
    },
    'lunch-in': {
      title: 'Confirm Lunch In',
      body: 'Are you sure you want to end your lunch break and resume work at this time?',
      confirmLabel: 'End Lunch',
    },
  } as const;

  const handleConfirmPunch = async () => {
    const action = confirmAction;
    setConfirmAction(null); // close first — toasts/banners behave as before
    if (action === 'out') {
      // Remote employees pause for the Daily Report modal before clock-out
      // completes; On-site employees clock out immediately as before. The
      // resolver re-fetches workModels at decision time if the mount fetch
      // failed, so a dropped fetch can't silently skip the modal.
      if (await resolveIsRemote()) {
        // Pre-fill with the report already saved today (e.g. from an earlier
        // shift on this same day), so a second clock-out lets the employee
        // edit/extend it instead of starting blank and overwriting it.
        setDailyReportText(status?.entry?.dailyReport ?? '');
        setDailyReportOpen(true);
        return;
      }
      await doPunchOut();
    } else if (action) {
      await doToggleLunch(); // toggles out or in per current state
    }
  };

  // Daily Report modal handlers. Save persists the entered (possibly edited)
  // note. "Skip" completes clock-out WITHOUT a report when none existed, but
  // PRESERVES an existing report saved earlier today (passing undefined leaves
  // the field untouched) rather than wiping it. Backdrop / Escape / X ABORT
  // the clock-out entirely (returning to the Confirm Clock Out dialog) so an
  // accidental dismissal never silently clocks the employee out.
  const handleDailyReportSave = async () => {
    setDailyReportOpen(false);
    await doPunchOut(dailyReportText);
  };
  const handleDailyReportSkip = async () => {
    setDailyReportOpen(false);
    // A report pre-filled from an earlier shift today is kept as-is; passing
    // undefined means punchOut leaves dailyReport untouched. Only when there
    // was no prior report do we write an explicit empty string.
    const existing = status?.entry?.dailyReport ?? '';
    await doPunchOut(existing.trim().length > 0 ? undefined : '');
  };
  // Abort: close the report modal and re-open the Clock Out confirmation so
  // the employee can confirm again or back out with no state mutation.
  const handleDailyReportAbort = () => {
    if (actionLoading) return; // never interrupt an in-flight write
    setDailyReportOpen(false);
    setConfirmAction('out');
  };

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isIn = status?.isClockedIn ?? false;
  const onLunch = status?.isOnLunch ?? false;
  const active = status?.activeSegment ?? null;

  // Primary action label + icon (one big tap target)
  let primaryLabel = 'CLOCK IN';
  let primaryIcon = <Clock className="h-5 w-5 mr-2" />;
  // `() => void` so both direct (Clock In) and dialog-opening (async-void) handlers fit.
  let primaryAction: () => void = doPunchIn;
  let primaryVariant: 'default' | 'destructive' | 'secondary' = 'default';

  if (isIn && !onLunch) {
    primaryLabel = 'CLOCK OUT';
    primaryIcon = <LogOut className="h-5 w-5 mr-2" />;
    primaryAction = () => setConfirmAction('out'); // confirmation first
    primaryVariant = 'destructive';
  } else if (isIn && onLunch) {
    primaryLabel = 'END LUNCH';
    primaryIcon = <Coffee className="h-5 w-5 mr-2" />;
    primaryAction = () => setConfirmAction('lunch-in'); // confirmation first
    primaryVariant = 'default';
  }

  const canDoLunch = isIn && !active?.complete;
  // A lunch break is "used" for this active segment when it was completed
  // (lunchIn set) or skipped. In both cases the segment can't take another
  // lunch, so the button is replaced with a disabled info state.
  const lunchUsed = !!active?.lunchInManual || !!active?.lunchInSystem || !!active?.skipLunch;
  const lunchLabel = onLunch ? 'END LUNCH' : lunchUsed ? 'Lunch break used for this shift' : 'START LUNCH';

  return (
    <div className="space-y-6 max-w-xl mx-auto px-4 pt-3 pb-3">
      {/* Live status header */}
      <div className="text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Punch Clock</h2>
        <p className="text-sm text-muted-foreground">
          One-tap clock in/out
        </p>
      </div>

      {/* Non-blocking guardrail warning: prior shift/lunch was auto-updated by
          the system. Advisory only — Clock In stays fully enabled below. */}
      {guardrailWarning && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800 shadow-sm"
        >
          <AlertTriangle className="size-5 shrink-0 mt-0.5 text-amber-500" />
          <p className="text-sm font-medium leading-snug">{guardrailWarning}</p>
        </div>
      )}

      {/* Layer 2: persistent write-failure banner. Stays visible until the
          action succeeds on retry or is dismissed — a fleeting toast was the
          root cause of employees believing a lost clock-out had landed. */}
      {writeFailure && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800 shadow-sm"
        >
          <WifiOff className="size-5 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">
              {writeFailure.action === 'out'
                ? 'Clock-out failed — you are still clocked in.'
                : writeFailure.action === 'in'
                  ? 'Clock-in failed — your shift was not started.'
                  : 'Lunch action failed — your shift was not updated.'}
            </p>
            <p className="text-xs text-rose-700 mt-0.5 break-words">
              {writeFailure.message}
            </p>
            <p className="text-xs text-rose-700 mt-0.5">
              Check your connection and retry. Your action was not saved.
            </p>
          </div>
          <div className="flex flex-col gap-1.5 shrink-0">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (writeFailure.action === 'out') doPunchOut();
                else if (writeFailure.action === 'in') doPunchIn();
                else doToggleLunch();
              }}
              disabled={!!actionLoading}
              className="h-8"
            >
              {actionLoading === writeFailure.action ? (
                <RefreshCw className="size-3.5 mr-1 animate-spin" />
              ) : null}
              Retry
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setWriteFailure(null)}
              className="h-8 text-rose-700 hover:text-rose-900 hover:bg-rose-100"
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Big visual status + live clock */}
      {status && (
        <ClockStatus
          isClockedIn={isIn}
          isOnLunch={onLunch}
          activeSegment={active}
          workMinutes={status.workMinutes}
          breakMinutes={status.breakMinutes}
          displayTimezone={displayTimezone}
          statusTimezone={employeeTz}
        />
      )}

      {/* Primary one-tap action */}
      <div className="pt-2">
        <Button
          onClick={primaryAction}
          disabled={!!actionLoading}
          variant={primaryVariant}
          className="w-full h-16 text-xl font-semibold active:scale-[0.985] transition-all touch-manipulation"
          size="lg"
        >
          {actionLoading === (isIn ? 'out' : 'in') ? (
            <RefreshCw className="h-5 w-5 mr-2 animate-spin" />
          ) : (
            primaryIcon
          )}
          {primaryLabel}
        </Button>

        {/* Secondary lunch toggle when clocked in. Stays rendered (but
            disabled) when the shift's lunch has already been used, showing
            "Lunch break used for this shift" with no interactive styling. */}
        {isIn && !onLunch && (
          <Button
            onClick={() => setConfirmAction('lunch-out')}
            disabled={lunchUsed || !canDoLunch || !!actionLoading}
            variant="outline"
            className={
              lunchUsed
                ? 'w-full h-12 mt-3 text-base font-medium cursor-not-allowed opacity-60 bg-muted/40 text-muted-foreground'
                : 'w-full h-12 mt-3 text-base font-medium active:scale-[0.985] touch-manipulation'
            }
          >
            {actionLoading === 'lunch' ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Coffee className="h-4 w-4 mr-2" />
            )}
            {lunchLabel}
          </Button>
        )}
      </div>

      {/* Guard message for double-punch attempts */}
      {!isIn && status?.entry && (
        <div className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5" />
          One open shift per day maximum. Previous shifts are archived automatically.
        </div>
      )}

      {/* This Week summary (simple, always visible, employee-friendly) */}
      {week && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              {/* Req 2b: week boundaries + label use the employee's local timezone */}
              This Week: Week of {week.weekStart} ({getTimezoneAbbreviation(employeeTz)})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <div className="text-3xl font-semibold tabular-nums">
                  {formatHoursHMM(week.totalMinutes / 60)}
                </div>
                <div className="text-xs uppercase tracking-widest text-muted-foreground">
                  Total Hours
                </div>
              </div>
              <div>
                <div className="text-3xl font-semibold tabular-nums">{week.daysWorked}</div>
                <div className="text-xs uppercase tracking-widest text-muted-foreground">
                  Days Worked
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Footer actions */}
      <div className="flex gap-3 pt-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={load}
          disabled={loading || !!actionLoading}
          className="flex-1"
        >
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        {onViewHistory && (
          <Button variant="outline" size="sm" onClick={onViewHistory} className="flex-1">
            View Work History
          </Button>
        )}
      </div>

      <p className="text-[10px] text-center text-muted-foreground">
        Times shown in your local timezone ({getTimezoneAbbreviation(employeeTz)}). Lunch uses existing segment model.
      </p>

      {/* Confirmation dialog for Lunch Out / Lunch In / Clock Out.
          Clock In intentionally stays one-tap (no confirmation). */}
      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          // Block dismissal via backdrop/Escape only while a punch is in flight;
          // Cancel/X always aborts with no state mutation otherwise.
          if (!open && !actionLoading) setConfirmAction(null);
        }}
      >
        <DialogContent className="max-w-sm">
          {confirmAction && (
            <>
              <DialogHeader>
                <DialogTitle>{CONFIRM_COPY[confirmAction].title}</DialogTitle>
                <DialogDescription>{CONFIRM_COPY[confirmAction].body}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setConfirmAction(null)}
                  disabled={!!actionLoading}
                >
                  Cancel
                </Button>
                <Button
                  variant={confirmAction === 'out' ? 'destructive' : 'default'}
                  onClick={handleConfirmPunch}
                  disabled={!!actionLoading}
                >
                  {actionLoading ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  {CONFIRM_COPY[confirmAction].confirmLabel}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Daily Report modal (Remote employees only). Shown after the Clock Out
          confirmation; pauses clock-out until Save (persist note) or Cancel
          (persist ""). Character-capped at DAILY_REPORT_MAX with a live count. */}
      <Dialog
        open={dailyReportOpen}
        onOpenChange={(open) => {
          // Backdrop / Escape / X closes without an explicit action: ABORT the
          // clock-out entirely (back to the Confirm Clock Out dialog) rather
          // than silently completing it — the modal is the employee's only
          // chance to attach a report, so an accidental dismissal must not
          // discard it. handleDailyReportAbort guards against an in-flight write.
          if (!open) handleDailyReportAbort();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Daily Report</DialogTitle>
            <DialogDescription>
              {(status?.entry?.dailyReport ?? '').trim().length > 0
                ? 'You already saved a report earlier today. Edit it below, or keep it as-is.'
                : 'Optionally summarize your work before clocking out.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Textarea
              value={dailyReportText}
              onChange={(e) => setDailyReportText(e.target.value.slice(0, DAILY_REPORT_MAX))}
              placeholder="Please describe what you worked on during this shift."
              maxLength={DAILY_REPORT_MAX}
              rows={4}
              disabled={!!actionLoading}
              autoFocus
            />
            <div className="text-right text-xs text-muted-foreground tabular-nums">
              {dailyReportText.length} / {DAILY_REPORT_MAX}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={handleDailyReportAbort}
              disabled={!!actionLoading}
            >
              Back
            </Button>
            <Button
              variant="outline"
              onClick={handleDailyReportSkip}
              disabled={!!actionLoading}
            >
              {(status?.entry?.dailyReport ?? '').trim().length > 0
                ? 'Keep Existing Report'
                : 'Clock Out Without Report'}
            </Button>
            <Button
              onClick={handleDailyReportSave}
              disabled={!!actionLoading}
            >
              {actionLoading ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Save &amp; Clock Out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
