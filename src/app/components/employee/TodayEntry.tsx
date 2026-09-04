import { useEffect, useMemo, useState } from 'react';
import { arrayUnion, collection, doc, getDoc, getDocs, limit, query, setDoc, Timestamp, updateDoc, where } from 'firebase/firestore';
import type { DocumentData } from 'firebase/firestore';
import { toast } from 'sonner';
import { AlertCircle, AlertTriangle, ArrowRight, CheckCircle2, Clock, Coffee, History, LogIn, LogOut as LogOutIcon, Zap, HelpCircle, FileWarning, CalendarDays, Globe, Play, Target } from 'lucide-react';

import type { User } from '../../lib/auth';
import type { CorrectionRequest, TimeEntry } from '../../lib/database';
import { dbService, buildConsistentClosePatch, createInitialSegment, stripUndefined } from '../../lib/database';
import { db } from '../../lib/firebase';
import { auditLogService } from '../../../services/auditLogService';
import { findOpenShiftEntry } from '../../../services/clockService';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Alert, AlertDescription } from '../ui/alert';
import { ProgressStepper } from '../ui/progress-stepper';
import { formatHoursHMM, getEmployeeTimezone, getLocalDate } from '../../../utils/timeCalculations';
import { dragmeService, type DragmeTask } from '../../../services/dragmeService';
import { HelpModal } from '../ui/help-modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';

// Existing business logic (ported from the previous HTML/JS app)
 
import { deriveSegmentWorkMinutes } from '../../../utils/timeCalculations';
import { getWorkWeekStartDate, DEFAULT_WORKWEEK_START_DAY } from '../../../utils/overtimeCalculations';
import {
  checkTimeAnomalies,
  validateClockIn,
  validateLunchOut,
  validateLunchIn,
  validateClockOut
} from '@/utils/timeValidation';
import { checkEntryAccess, getYesterdayDate } from '../../../utils/timeWindows';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";

interface TodayEntryProps {
  user: User;
  onViewHistory: () => void;
}

export function TodayEntry({ user, onViewHistory }: TodayEntryProps) {
  const TEST_MODE =
    import.meta.env.VITE_TEST_MODE === 'true' ||
    (import.meta.env.DEV && new URLSearchParams(window.location.search).has('test'));

  const [entry, setEntry] = useState<TimeEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [lockedDate, setLockedDate] = useState<string | null>(null);

  // Anomaly warning state
  const [anomalyWarning, setAnomalyWarning] = useState<string | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<(() => Promise<void>) | null>(null);

  const [currentTime, setCurrentTime] = useState('');
  const [liveTime, setLiveTime] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);

  // Dragme integration
  const [tasks, setTasks] = useState<DragmeTask[]>([]);
  const [taskId, setTaskId] = useState<string>('');

  // Correction request modal state
  const [correctionModalOpen, setCorrectionModalOpen] = useState(false);
  const [correctionIssueType, setCorrectionIssueType] = useState('');
  const [correctionNotes, setCorrectionNotes] = useState('');
  const [correctionSuggestedTime, setCorrectionSuggestedTime] = useState('');
  const [correctionRequestedIn, setCorrectionRequestedIn] = useState('');
  const [correctionRequestedOut, setCorrectionRequestedOut] = useState('');
  const [correctionRequestedLunch, setCorrectionRequestedLunch] = useState('');
  const [correctionDate, setCorrectionDate] = useState('');
  const [submittingCorrection, setSubmittingCorrection] = useState(false);

  const tz = getEmployeeTimezone(user.timezone);
  // Entry doc id / date queries use the employee's LOCAL calendar date
  // (YYYY-MM-DD in their own timezone) — NOT the UTC date (the old
  // `new Date().toISOString().split('T')[0]` bug) and NOT fixed Pacific Time.
  // This is the local-time-tracking refactor (Req 1).
  const today = useMemo(() => getLocalDate(tz), [tz]);

  useEffect(() => {
    // Set initial manual time once on mount
    const now = new Date();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCurrentTime(now.toTimeString().slice(0, 5));

    // Update live clock every second
    const updateLiveTime = () => {
      setLiveTime(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
    };
    updateLiveTime();

    const interval = setInterval(updateLiveTime, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    void initLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load Dragme task list once on mount (no-ops in dev if unconfigured)
  useEffect(() => {
    (async () => {
      try {
        const list = await dragmeService.fetchTasks();
        setTasks(list);
      } catch {
        // Silent — dropdown will simply show "No tasks available".
      }
    })();
  }, []);

  async function initLoad() {
    setLoading(true);
    setBlockedMessage(null);
    setWarningMessage(null);

    try {
      const settings = await dbService.getPayrollSettings();
      if (settings?.locked_up_to_date) {
        setLockedDate(settings.locked_up_to_date);
        if (today <= settings.locked_up_to_date) {
          setBlockedMessage(`This pay period has been locked by an administrator (Up to ${settings.locked_up_to_date}).`);
        }
      }

      // Access rules (same spirit as old app): employees can be blocked by yesterday/time-window rules.
      // Admins bypass; TEST_MODE bypasses locally.
      const isAdmin = user.role === 'admin';
      if (!TEST_MODE && !isAdmin) {
        const yesterdayDate = getYesterdayDate();
        const ySnap = await getDoc(doc(db, 'timeEntries', `${user.uid}_${yesterdayDate}`));
        let yesterdayEntry: DocumentData | null = ySnap.exists() ? ySnap.data() : null;

        const tSnap = await getDoc(doc(db, 'timeEntries', `${user.uid}_${today}`));
        const todayEntryRaw: DocumentData | null = tSnap.exists() ? tSnap.data() : null;

        // First-day exception (copied from old sequential logic)
        if (!yesterdayEntry && !todayEntryRaw) {
          const anyEntrySnap = await getDocs(
            query(collection(db, 'timeEntries'), where('userId', '==', user.uid), limit(1))
          );
          if (anyEntrySnap.empty) {
            yesterdayEntry = { dayComplete: true, clockOutManual: '00:00' };
          }
        }

        const accessCheck = checkEntryAccess({
          workDate: today,
          yesterdayEntry,
          currentEntry: todayEntryRaw,
        });

        if (!accessCheck.canAccess) {
          setBlockedMessage(accessCheck.message || 'Entry blocked.');
          // If they already completed today and the rules want to show summary, we still load the entry.
        }

        if (accessCheck.warningMessage) {
          setWarningMessage(accessCheck.warningMessage);
        }
      }

      const existingEntry = await dbService.getTimeEntry(user.uid, today);
      setEntry(existingEntry);
    } catch {
      toast.error('Failed to load entry');
    } finally {
      setLoading(false);
    }
  }

  async function submitClockIn(anomalyLog = false) {
    const validation = validateClockIn(currentTime);
    if (!validation.valid) {
      toast.error(validation.message);
      return;
    }

    // Enforce the one-open-shift invariant across recent days (including an
    // unclosed cross-midnight shift from a previous day). This mirrors
    // clockService.punchIn so the legacy form can't open a second overlapping
    // shift. Block unconditionally when ANY recent doc is open — a completed
    // TODAY doc is not exempt (findOpenShiftEntry returns null for completed
    // docs, so the legit split-shift path still works; a ghost open shift on
    // a PRIOR day must block the new clock-in, exactly like punchIn).
    try {
      const openShift = await findOpenShiftEntry(user.uid, tz);
      if (openShift) {
        toast.error(
          `You already have an open shift (started ${openShift.date}). Clock out before starting a new one.`
        );
        return;
      }
    } catch {
      // Fall back to the local check below if the cross-day scan fails.
    }

    // Block only if there's an OPEN (incomplete) clock-in. Completed entries
    // are allowed to start a new split-shift segment.
    if (entry?.clockInManual && !entry.complete) {
      toast.error('This action has already been recorded.');
      return;
    }

    const now = Timestamp.now();
    const entryId = `${user.uid}_${today}`;
    const workWeekStartDate = getWorkWeekStartDate(today, DEFAULT_WORKWEEK_START_DAY);

    // --- Split shift: archive previous completed segment, start a fresh one. ---
    if (entry?.complete && entry.clockInManual && entry.clockOutManual) {
      // Derive the just-completed shift's minutes directly from the top-level
      // legacy fields. `entry.segments` (per mapEntry) contains ONLY previously
      // archived shifts, NOT the current one — so reading `segments[last]`
      // returns the wrong (or no) value. On the first split, segments[] is
      // empty and the prior code wrote workMinutes: 0, losing shift #1's total.
      // Uses the shared canonical helper so this stays in sync with mapEntry.
      const justCompletedMins = deriveSegmentWorkMinutes(
        entry.clockInManual,
        entry.clockOutManual,
        entry.skipLunch,
        entry.lunchOutManual,
        entry.lunchInManual,
      );

      // entry.segments holds only previously-archived shifts (no synthesized
      // current lives there). Sum all of them, then add the just-completed
      // shift to get the running day total.
      const priorArchivedMins = (entry.segments || []).reduce(
        (s, seg) => s + (seg.workMinutes || 0),
        0,
      );
      const accumulatedMinutes = priorArchivedMins + justCompletedMins;

      // S7 (split-shift consistency): persist the new OPEN segment into
      // segments[] alongside the just-completed (closed) segment, mirroring
      // clockService.punchIn. Without this, segments[] ends in the closed
      // seg1 while the open seg2 lives only in top-level fields — which
      // triggers mapEntry's S1 fallback to inherit seg1's clockOutManual
      // up to the entry, falsely rendering seg2 as complete ("looks clocked
      // out" bug). Ending segments[] in an open segment keeps every reader
      // (ClockPunch, HistoryView, getActiveSegment) seeing the live open
      // shift correctly.
      const openSeg = stripUndefined(createInitialSegment(currentTime, now.toMillis(), taskId || undefined));

      await updateDoc(doc(db, 'timeEntries', entryId), {
        // Archive the just-completed segment AND append the new open segment
        segments: arrayUnion({
          id: `seg_${Date.now()}`,
          clockInManual: entry.clockInManual,
          clockInSystemTime: entry.clockInSystem ? new Date(entry.clockInSystem) : null,
          lunchOutManual: entry.lunchOutManual || null,
          lunchOutSystemTime: entry.lunchOutSystem ? new Date(entry.lunchOutSystem) : null,
          lunchInManual: entry.lunchInManual || null,
          lunchInSystemTime: entry.lunchInSystem ? new Date(entry.lunchInSystem) : null,
          clockOutManual: entry.clockOutManual,
          clockOutSystemTime: entry.clockOutSystem ? new Date(entry.clockOutSystem) : null,
          skipLunch: !!entry.skipLunch,
          workMinutes: justCompletedMins,
          taskId: entry.taskId || null,
          complete: true,
        }, openSeg),
        // Reset the "current segment" top-level fields for a fresh shift
        clockInManual: currentTime,
        clockInSubmitted: true,
        clockInSystemTime: now,
        lunchOutManual: '',
        lunchOutSubmitted: false,
        lunchOutSystemTime: null,
        lunchInManual: '',
        lunchInSubmitted: false,
        lunchInSystemTime: null,
        clockOutManual: '',
        clockOutSubmitted: false,
        clockOutSystemTime: null,
        lunchSkipped: false,
        currentStep: 2,
        dayComplete: false,
        complete: false,
        completedAt: null,
        autoClosed: false,
        taskId: taskId || null,
        // Keep accumulated minutes so History/Complete views show day totals correctly
        totalWorkMinutes: accumulatedMinutes,
        updatedAt: now,
        updatedBy: user.uid,
        ...(anomalyLog && { anomaly_flag: true }),
      });
      return;
    }

    await setDoc(
      doc(db, 'timeEntries', entryId),
      {
        userId: user.uid,
        workDate: today,
        clockInManual: currentTime,
        clockInSubmitted: true,
        clockInSystemTime: now,
        currentStep: 2,
        dayComplete: false,
        workWeekStartDate,
        taskId: taskId || null,
        createdAt: now,
        createdBy: user.uid,
        updatedAt: now,
        updatedBy: user.uid,
        ...(anomalyLog && { anomaly_flag: true }),
      },
      { merge: true }
    );
  }

  async function submitLunchOut(skip = false, anomalyLog = false) {
    if (!entry?.clockInManual) {
      toast.error('Clock In is required first');
      return;
    }

    // Duplicate Check    
    if (entry?.lunchOutManual || entry?.skipLunch) {
      toast.error('This action has already been recorded.');
      return;
    }

    if (!skip) {
      const validation = validateLunchOut(currentTime, entry.clockInManual);
      if (!validation.valid) {
        toast.error(validation.message);
        return;
      }
    }

    const now = Timestamp.now();
    const entryId = `${user.uid}_${today}`;
    await updateDoc(doc(db, 'timeEntries', entryId), {
      lunchOutManual: skip ? '' : currentTime,
      lunchOutSubmitted: true,
      lunchSkipped: skip,
      lunchOutSystemTime: skip ? null : now,
      currentStep: skip ? 4 : 3,
      updatedAt: now,
      updatedBy: user.uid,
      ...(anomalyLog && { anomaly_flag: true }),
    });
  }

  async function submitLunchIn(anomalyLog = false) {
    if (!entry?.lunchOutManual) {
      toast.error('Lunch Out is required first');
      return;
    }

    // Duplicate Check
    if (entry?.lunchInManual) {
      toast.error('This action has already been recorded.');
      return;
    }

    const validation = validateLunchIn(currentTime, entry.lunchOutManual);
    if (!validation.valid) {
      toast.error(validation.message);
      return;
    }

    const now = Timestamp.now();
    const entryId = `${user.uid}_${today}`;
    await updateDoc(doc(db, 'timeEntries', entryId), {
      lunchInManual: currentTime,
      lunchInSubmitted: true,
      lunchInSystemTime: now,
      currentStep: 4,
      updatedAt: now,
      updatedBy: user.uid,
      ...(anomalyLog && { anomaly_flag: true }),
    });
  }

  async function submitClockOut(anomalyLog = false) {
    if (!entry?.clockInManual) {
      toast.error('Clock In is required first');
      return;
    }
    if (!entry?.skipLunch && !entry?.lunchInManual) {
      toast.error('Lunch In is required first (or skip lunch)');
      return;
    }

    // Duplicate Check
    if (entry?.clockOutManual) {
      toast.error('This action has already been recorded.');
      return;
    }

    const validation = validateClockOut(
      currentTime,
      entry.clockInManual,
      entry.skipLunch ? null : entry.lunchInManual || null
    );
    if (!validation.valid) {
      toast.error(validation.message);
      return;
    }

    // S7: derive the closed segment + day total via the canonical
    // buildConsistentClosePatch (closeActiveSegment math: S6 cross-midnight
    // wrap + lunch deduction) so root fields, segments[last], and
    // totalWorkMinutes are written together and can never diverge. 'append'
    // preserves prior archived split-shift segments. This replaces the
    // manual deriveSegmentWorkMinutes + archivedMins sum so the stored
    // segment's workMinutes and totalWorkMinutes always agree.
    const closePatch = buildConsistentClosePatch({
      clockIn: entry.clockInManual,
      clockOut: currentTime,
      skipLunch: !!entry.skipLunch,
      lunchOut: entry.skipLunch ? undefined : (entry.lunchOutManual || undefined),
      lunchIn: entry.skipLunch ? undefined : (entry.lunchInManual || undefined),
      clockOutSystem: Date.now(),
      clockInSystem: entry.clockInSystem,
      taskId: entry.taskId || undefined,
      existingSegments: entry.segments,
      mode: 'append',
    });
    const totalMins = closePatch.totalWorkMinutes;
    const segMins = closePatch.closedSegment.workMinutes ?? 0;

    const now = Timestamp.now();
    const entryId = `${user.uid}_${today}`;
    await updateDoc(doc(db, 'timeEntries', entryId), {
      clockOutManual: currentTime,
      clockOutSubmitted: true,
      clockOutSystemTime: now,
      clockOutSystem: now.toMillis(),
      complete: true,
      dayComplete: true, // Legacy flag
      currentStep: 4,
      completedAt: now,
      segments: closePatch.segments,
      totalWorkMinutes: totalMins, // Raw minutes for admin rules later
      currentSegmentMinutes: Math.max(0, segMins),
      updatedAt: now,
      updatedBy: user.uid,
      ...(anomalyLog && { anomaly_flag: true }),
    });

    // Push to Dragme (best-effort, non-blocking on UI success)
    if (taskId) {
      dragmeService
        .syncEntry({
          entryId,
          taskId,
          totalHours: totalMins / 60,
          date: today,
          userId: user.uid,
        })
        .catch((err: unknown) => {
          toast.error(`Dragme sync failed: ${(err as Error)?.message || 'unknown error'}`);
        });
    }
  }

  async function handleSubmitStep(bypassWarning = false) {
    if (submitting) return;
    if (!currentTime) return;

    // Check for anomalies before submitting
    if (!bypassWarning) {
      const stepIndex = entry?.currentStep || 0;
      const anomalyCheck = checkTimeAnomalies(stepIndex, currentTime, today, entry);

      if (anomalyCheck.hasAnomaly) {
        setAnomalyWarning(anomalyCheck.message || 'Unusual time entry detected.');
        setPendingSubmit(() => () => handleSubmitStep(true));
        return; // Pause submission until confirmed
      }
    }

    setSubmitting(true);
    try {
      if (!entry || entry.currentStep === 0) {
        await submitClockIn(bypassWarning);
      } else if (entry.currentStep === 1) {
        await submitLunchOut(false, bypassWarning);
      } else if (entry.currentStep === 2) {
        await submitLunchIn(bypassWarning);
      } else if (entry.currentStep === 3) {
        await submitClockOut(bypassWarning);
      }

      toast.success('Time submitted successfully');
      await initLoad();
    } catch (e: unknown) {
      toast.error((e as Error)?.message || 'Failed to submit time');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSkipLunch(bypassWarning = false) {
    if (submitting) return;

    // Check for anomalies before skipping lunch
    if (!bypassWarning) {
      const stepIndex = entry?.currentStep || 0;
      const anomalyCheck = checkTimeAnomalies(stepIndex, currentTime, today, entry);

      if (anomalyCheck.hasAnomaly) {
        setAnomalyWarning(anomalyCheck.message || 'Unusual time entry detected.');
        setPendingSubmit(() => () => handleSkipLunch(true));
        return; // Pause submission until confirmed
      }
    }

    setSubmitting(true);
    try {
      if (!entry) {
        // Must clock in first in this flow
        toast.error('Clock In first, then you can skip lunch');
        return;
      }
      await submitLunchOut(true);
      toast.success('Lunch skipped');
      await initLoad();
    } catch (e: unknown) {
      toast.error((e as Error)?.message || 'Failed to skip lunch');
    } finally {
      setSubmitting(false);
    }
  }

  async function resetToday() {
    if (!confirm('Void today\'s entry? This will mark it as voided but preserve the record for audit purposes.')) return;
    try {
      const entryId = `${user.uid}_${today}`;
      const entryDoc = await getDoc(doc(db, 'timeEntries', entryId));
      const before = entryDoc.exists() ? entryDoc.data() : {};
      await auditLogService.logVoidEntry({
        actorUid: user.uid,
        actorName: user.name || user.email,
        actorRole: 'system',
        targetId: entryId,
        before,
        reason: 'Employee voided today\'s entry (test mode)',
      });
      await updateDoc(doc(db, 'timeEntries', entryId), {
        status: 'voided',
        voidedAt: Timestamp.now(),
        voidedBy: user.uid,
        voidReason: 'Employee voided via test mode',
        updatedAt: Timestamp.now(),
        updatedBy: user.uid,
      });
      toast.success('Entry voided');
      await initLoad();
    } catch {
      toast.error('Failed to void entry');
    }
  }

  const calculateEstimatedHours = () => {
    if (!entry?.clockInManual) return null;

    // Bug fix: previously `new Date(today).setHours(...)` mixed the YYYY-MM-DD
    // string (UTC-anchored) with setHours (local-TZ). For users in Asia/Bangkok
    // on a UTC server this produced an Invalid Date, making "hours so far"
    // show NaN. Now use minute arithmetic instead of Date math — the wall-clock
    // times are in the user's TZ so direct subtraction is correct.
    const toMin = (s: string): number => {
      const [h, m] = s.split(':').map(Number);
      return h * 60 + m;
    };
    let totalMin = toMin(currentTime) - toMin(entry.clockInManual);

    if (entry.lunchOutManual && entry.lunchInManual && !entry.skipLunch) {
      totalMin -= toMin(entry.lunchInManual) - toMin(entry.lunchOutManual);
    }

    const totalHours = totalMin / 60;
    return totalHours > 0 ? totalHours : 0;
  };

  const getStepInfo = () => {
    const step = entry?.currentStep || 0;
    const steps = [
      { label: 'Clock In', icon: LogIn, completed: step >= 1 },
      { label: 'Lunch Out', icon: Coffee, completed: step >= 2 },
      { label: entry?.skipLunch ? 'Skipped' : 'Lunch In', icon: Coffee, completed: step >= 3 },
      { label: 'Clock Out', icon: LogOutIcon, completed: step >= 4 },
    ];
    return { steps, currentStep: step };
  };

  const renderStepForm = () => {
    // UX fix: when access is blocked (e.g. yesterday-incomplete, time-window
    // closed, payroll locked), don't just disable the submit button — hide
    // the input form entirely. Showing editable fields next to a red block
    // banner is confusing and made testers think the system was broken.
    if (blockedMessage && !entry?.complete) {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50/60 p-6 text-center space-y-2">
          <AlertCircle className="mx-auto size-8 text-red-500" />
          <p className="text-sm text-red-800 font-medium">Entry locked</p>
          <p className="text-xs text-red-700">
            Resolve the issue above to enable the time entry form.
          </p>
        </div>
      );
    }

    const step = entry?.currentStep || 0;

    if (entry?.complete) {
      const dayTotalHours = entry.totalHours || 0;
      const targetHours = 8;
      const progressPct = Math.min(100, (dayTotalHours / targetHours) * 100);
      const progressColor =
        dayTotalHours >= 10 ? 'bg-amber-500' : dayTotalHours >= targetHours ? 'bg-emerald-500' : 'bg-indigo-600';
      const segments = entry.segments || [];
      return (
        <div className="space-y-4">
          <Alert className="bg-green-50 border-green-200">
            <CheckCircle2 className="size-5 text-green-600" />
            <AlertDescription className="text-green-900 ml-2">
              Today's entry complete! Contact your manager for corrections.
            </AlertDescription>
          </Alert>

          {/* Per-segment summary (split shifts) */}
          {segments.length > 1 ? (
            <div className="space-y-2">
              {segments.map((seg, i) => (
                <div key={seg.id} className="grid grid-cols-4 gap-2 bg-slate-50 p-2 rounded-lg border border-slate-200 text-sm">
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase">Shift {i + 1} In</p>
                    <p className="font-semibold text-slate-900">{seg.clockInManual || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase">Lunch</p>
                    <p className="font-semibold text-slate-900">
                      {seg.skipLunch ? 'Skipped' : (seg.lunchOutManual && seg.lunchInManual ? `${seg.lunchOutManual}–${seg.lunchInManual}` : '—')}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase">Out</p>
                    <p className="font-semibold text-slate-900">{seg.clockOutManual || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase">Hours</p>
                    <p className="font-semibold text-slate-900">{formatHoursHMM((seg.workMinutes || 0) / 60)}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                  <LogIn className="size-3" /> Clock In
                </p>
                <p className="text-xl font-bold text-slate-900">{entry.clockInManual}</p>
              </div>
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                  <LogOutIcon className="size-3" /> Clock Out
                </p>
                <p className="text-xl font-bold text-slate-900">{entry.clockOutManual}</p>
              </div>
              {!entry.skipLunch && (
                <>
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                      <Coffee className="size-3" /> Lunch Start
                    </p>
                    <p className="text-lg font-bold text-slate-900">{entry.lunchOutManual}</p>
                  </div>
                  <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                    <p className="text-xs text-slate-600 mb-1 flex items-center gap-1">
                      <Coffee className="size-3" /> Lunch End
                    </p>
                    <p className="text-lg font-bold text-slate-900">{entry.lunchInManual}</p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Total Hours + Linear Progress Bar */}
          <div className="bg-blue-50 rounded-lg p-4 border border-blue-200 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-700">Total Hours</span>
              <span className="text-3xl font-bold text-blue-600 tabular-nums">
                {formatHoursHMM(dayTotalHours)}
              </span>
            </div>
            <div className="relative h-3 w-full overflow-hidden rounded-full bg-blue-100">
              <div
                className={`h-full transition-all duration-500 ${progressColor}`}
                style={{ width: `${progressPct}%` }}
                aria-valuenow={Math.round(progressPct)}
                aria-valuemin={0}
                aria-valuemax={100}
                role="progressbar"
              />
            </div>
            <div className="flex items-center justify-between text-xs text-slate-600 tabular-nums">
              <span>0:00</span>
              <span className="font-medium">{Math.round(progressPct)}% of {targetHours}:00</span>
              <span>{targetHours}:00+</span>
            </div>
          </div>

          {/* Start New Shift (split shift) */}
          <Button
            onClick={async () => {
              const now = new Date();
              setCurrentTime(now.toTimeString().slice(0, 5));
              setSubmitting(true);
              try {
                await submitClockIn(false);
                toast.success('New shift started');
                await initLoad();
              } catch (e: unknown) {
                toast.error((e as Error)?.message || 'Failed to start new shift');
              } finally {
                setSubmitting(false);
              }
            }}
            disabled={submitting || !!blockedMessage}
            variant="outline"
            className="w-full h-12 border-2 border-indigo-300 text-indigo-700 hover:bg-indigo-50 rounded-xl font-semibold"
          >
            <Play className="size-4 mr-2" />
            Start New Shift
          </Button>

          {entry.flags && entry.flags.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertDescription className="ml-2 text-sm">
                Flags: {entry.flags.join(', ')}
              </AlertDescription>
            </Alert>
          )}

          {TEST_MODE && (
            <Button variant="destructive" onClick={resetToday}>
              Reset Today (Test Mode)
            </Button>
          )}
        </div>
      );
    }

    const stepLabels = ['Clock In', 'Lunch Out', 'Lunch In', 'Clock Out'];
    const stepIcons = [LogIn, Coffee, Coffee, LogOutIcon];
    const CurrentIcon = stepIcons[step];
    const estimatedHours = calculateEstimatedHours();

    return (
      <div className="space-y-4">
        {/* Current Time - Compact */}
        <div className="bg-indigo-50/50 backdrop-blur-sm border border-indigo-100 rounded-xl p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="size-5 text-indigo-600" />
              <span className="text-sm font-semibold text-indigo-900/70">Current Time</span>
            </div>
            <p className="text-3xl font-black tracking-tight text-indigo-600 drop-shadow-sm">{liveTime}</p>
          </div>
          {estimatedHours !== null && estimatedHours > 0 && (
            <div className="mt-3 pt-3 border-t border-indigo-200/50 flex items-center justify-between">
              <span className="text-xs font-semibold text-indigo-900/60 uppercase tracking-wider">Hours so far</span>
              <span className="text-xl font-bold text-indigo-700 tabular-nums">{formatHoursHMM(estimatedHours)}</span>
            </div>
          )}
        </div>

        {/* Time Input */}
        <div className="space-y-3">
          <Label htmlFor="time" className="flex items-center gap-2 font-semibold text-slate-700">
            <CurrentIcon className="size-4 text-indigo-500" />
            Enter {stepLabels[step]} Time
          </Label>
          <Input
            id="time"
            type="time"
            value={currentTime}
            onChange={(e) => setCurrentTime(e.target.value)}
            className="h-14 text-xl text-center font-bold bg-white/60 border-indigo-100 focus:border-indigo-500 focus:ring-indigo-500 rounded-xl shadow-inner transition-all"
          />
          <Button
            onClick={() => {
              const now = new Date();
              const timeString = now.toTimeString().slice(0, 5);
              setCurrentTime(timeString);
            }}
            variant="outline"
            size="sm"
            className="w-full text-indigo-600 border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 text-sm font-medium rounded-xl h-10 transition-colors"
          >
            <Zap className="size-4 mr-2" />
            Use Current Time
          </Button>
        </div>

        {/* Task selector (Dragme) — shown on Clock In step only */}
        {step === 0 && (
          <div className="space-y-2">
            <Label htmlFor="task" className="flex items-center gap-2 font-semibold text-slate-700">
              <Target className="size-4 text-indigo-500" />
              Task
              <span className="text-xs font-normal text-slate-400">(optional)</span>
            </Label>
            <Select value={taskId || 'none'} onValueChange={(v) => setTaskId(v === 'none' ? '' : v)}>
              <SelectTrigger id="task" className="h-12 bg-white/60 border-indigo-100 rounded-xl">
                <SelectValue placeholder="Select a task…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— No task —</SelectItem>
                {tasks.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.project ? `${t.project} • ${t.name}` : t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tasks.length === 0 && (
              <p className="text-xs text-slate-400">No Dragme tasks available.</p>
            )}
          </div>
        )}

        {/* Submit Button */}
        <Button
          onClick={() => handleSubmitStep(false)}
          disabled={!currentTime || submitting || !!blockedMessage}
          className="w-full h-14 text-lg font-bold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-lg shadow-indigo-200 transition-all active:scale-[0.98]"
        >
          {submitting ? 'Submitting...' : `Submit ${stepLabels[step]}`}
        </Button>

        {step === 1 && (
          <div className="pt-2">
            <Button
              variant="outline"
              className="w-full h-12 border-dashed border-2 border-slate-300 text-slate-600 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50/50 rounded-xl font-medium transition-all"
              onClick={() => handleSkipLunch(false)}
              disabled={submitting || !!blockedMessage}
            >
              <Coffee className="size-4 mr-2" />
              Skip Lunch Break
            </Button>
          </div>
        )}
      </div>
    );
  };

  async function handleRequestCorrection() {
    setSubmitting(true);
    try {
      const yesterdayDate = getYesterdayDate();
      const needsCorrectionToday = blockedMessage?.includes('time window has closed');
      const targetDate = needsCorrectionToday ? today : yesterdayDate;
      const targetId = `${user.uid}_${targetDate}`;

      await updateDoc(doc(db, 'timeEntries', targetId), {
        correctionRequested: true,
        updatedAt: Timestamp.now(),
        updatedBy: user.uid
      });

      toast.success('Manager notified for correction.');
      await initLoad();
    } catch (e: unknown) {
      toast.error('Failed to request correction: ' + ((e as Error).message || 'Unknown error'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmitCorrectionRequest() {
    if (!correctionIssueType) {
      toast.error('Please select an issue type.');
      return;
    }
    if (!correctionNotes.trim()) {
      toast.error('Notes are required.');
      return;
    }

    setSubmittingCorrection(true);
    try {
      const targetDate = correctionDate || today;

      if (lockedDate && targetDate <= lockedDate) {
        toast.error(`Corrections for ${targetDate} are locked by an administrator.`);
        setSubmittingCorrection(false);
        return;
      }

      const originalEntry = await dbService.getTimeEntry(user.uid, targetDate);

      let original_lunch: string | undefined = undefined;
      if (originalEntry) {
        if (originalEntry.skipLunch) original_lunch = "Skipped";
        else if (originalEntry.lunchOutManual && originalEntry.lunchInManual) {
          original_lunch = `${originalEntry.lunchOutManual} - ${originalEntry.lunchInManual}`;
        }
      }

      const payload: Omit<CorrectionRequest, 'id'> = {
        employee_id: user.uid,
        employee_name: user.name,
        requested_date: targetDate,
        issue_type: correctionIssueType,
        notes: correctionNotes.trim(),
        status: 'Open',
        created_at: Date.now(),
      };

      if (correctionSuggestedTime) payload.suggested_time = correctionSuggestedTime;
      if (originalEntry?.clockInManual) payload.original_clock_in = originalEntry.clockInManual;
      if (originalEntry?.clockOutManual) payload.original_clock_out = originalEntry.clockOutManual;
      if (original_lunch) payload.original_lunch = original_lunch;

      if (correctionRequestedIn) payload.requested_clock_in = correctionRequestedIn;
      if (correctionRequestedOut) payload.requested_clock_out = correctionRequestedOut;
      if (correctionRequestedLunch) payload.requested_lunch = correctionRequestedLunch;

      await dbService.createCorrectionRequest(payload);

      toast.success('Correction request submitted successfully.');
      setCorrectionModalOpen(false);
      setCorrectionIssueType('');
      setCorrectionNotes('');
      setCorrectionSuggestedTime('');
      setCorrectionRequestedIn('');
      setCorrectionRequestedOut('');
      setCorrectionRequestedLunch('');
      setCorrectionDate('');
    } catch (e: unknown) {
      console.error('[CorrectionRequest] Failed to submit:', e);
      toast.error('Failed to submit correction request. Please ensure all data is valid and try again.');
    } finally {
      setSubmittingCorrection(false);
    }
  }

  const openCorrectionModal = () => {
    setCorrectionDate(today);
    setCorrectionModalOpen(true);
  };

  if (loading) {
    return (
      <div className="p-8 text-center">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent"></div>
        <p className="mt-4 text-slate-600">Loading...</p>
      </div>
    );
  }

  const { steps, currentStep } = getStepInfo();

  const stepperSteps = [
    { id: 'clock-in', label: 'Clock In' },
    { id: 'lunch-out', label: 'Lunch Out' },
    { id: 'lunch-in', label: entry?.skipLunch ? 'Skipped' : 'Lunch In' },
    { id: 'clock-out', label: 'Clock Out' },
  ];

  // Format effective work date for header
  const effectiveDateStr = (() => {
    try {
      const dateObj = new Date(today + 'T12:00:00'); // noon to avoid TZ issues
      return new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: tz,
      }).format(dateObj);
    } catch {
      return today;
    }
  })();

  const ISSUE_TYPES = [
    'Missed Clock In',
    'Missed Lunch Out',
    'Missed Lunch In',
    'Missed Clock Out',
    'Wrong Time',
    'Locked Day',
    'Time Window Closed',
    'Other',
  ];

  return (
    <div className="space-y-6 pb-24">
      {/* Date & Timezone Header */}
      <div className="bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-100/60 rounded-2xl p-4 md:p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-100 p-2.5 rounded-xl">
            <CalendarDays className="size-5 text-indigo-600" />
          </div>
          <div>
            <h2 className="text-base md:text-lg font-bold text-slate-800">
              Time Entry — {effectiveDateStr}
            </h2>
            <p className="text-xs md:text-sm text-slate-500 flex items-center gap-1.5 mt-0.5">
              <Globe className="size-3.5" />
              Timezone: {tz}
            </p>
          </div>
        </div>
      </div>

      {warningMessage && !blockedMessage && (
        <Alert className="bg-amber-50 rounded-2xl p-4 border border-amber-200 mt-4 mx-4 shadow-sm flex items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-5 shrink-0 text-amber-500" />
            <AlertDescription className="text-sm font-medium text-amber-800">
              {warningMessage}
            </AlertDescription>
          </div>
        </Alert>
      )}

      {blockedMessage && (
        <Alert variant="destructive" className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-5 shrink-0" />
            <AlertDescription className="text-sm font-medium">
              {blockedMessage}
            </AlertDescription>
          </div>
          {(blockedMessage.includes('time window has closed') || blockedMessage.includes('previous day')) && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRequestCorrection}
              disabled={submitting}
              className="w-full sm:w-auto shrink-0 bg-white hover:bg-red-50 text-red-700 border-red-200"
            >
              Request Manager Correction
            </Button>
          )}
        </Alert>
      )}

      {/* Progress Stepper */}
      <Card className="border border-indigo-100/50 shadow-xl bg-white/80 backdrop-blur-xl rounded-2xl overflow-hidden">
        <CardContent className="pt-8 pb-8 px-6">
          <ProgressStepper
            steps={stepperSteps}
            currentStep={entry?.complete ? 4 : currentStep}
          />
        </CardContent>
      </Card>

      {/* Current Step Card */}
      <Card className="border border-white/60 shadow-2xl bg-white/70 backdrop-blur-xl rounded-2xl overflow-hidden">
        <CardHeader className="pb-4 bg-white/40 border-b border-indigo-50">
          <CardTitle className="text-lg font-bold text-slate-800 flex items-center gap-3">
            {entry?.complete ? (
              <>
                <div className="bg-green-100 p-2 rounded-full">
                  <CheckCircle2 className="size-5 text-green-600" />
                </div>
                Entry Complete
              </>
            ) : (
              <>
                <div className="bg-indigo-100 p-2 rounded-full shadow-sm">
                  <ArrowRight className="size-5 text-indigo-600" />
                </div>
                {steps[currentStep]?.label || 'Clock In'}
              </>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-6 px-6 pb-8">
          {renderStepForm()}
        </CardContent>
      </Card>

      {/* View History + Request Correction Buttons - Fixed at bottom */}
      <div className="fixed bottom-6 left-0 right-0 px-4 sm:px-6 z-50 max-w-4xl mx-auto flex items-center justify-between gap-2 sm:gap-3 pointer-events-none">
        <Button
          variant="outline"
          onClick={onViewHistory}
          className="flex-1 h-12 sm:h-14 pointer-events-auto bg-white/90 backdrop-blur-lg shadow-2xl border border-indigo-100 text-indigo-700 hover:bg-indigo-50/80 rounded-2xl font-bold text-sm sm:text-lg transition-all"
        >
          <History className="size-4 sm:size-5 mr-2 sm:mr-3" />
          <span className="truncate">View History</span>
        </Button>
        <Button
          variant="outline"
          onClick={openCorrectionModal}
          className="size-12 sm:size-14 pointer-events-auto bg-amber-50/90 backdrop-blur-lg shadow-2xl border border-amber-200 text-amber-700 hover:bg-amber-100 rounded-2xl shrink-0"
          title="Request Correction"
        >
          <FileWarning className="size-5 sm:size-6" />
        </Button>
        <Button
          variant="outline"
          onClick={() => setHelpOpen(true)}
          className="size-12 sm:size-14 pointer-events-auto bg-indigo-50/90 backdrop-blur-lg shadow-2xl border border-indigo-200 text-indigo-700 hover:bg-indigo-100 rounded-2xl shrink-0"
        >
          <HelpCircle className="size-5 sm:size-6" />
        </Button>
      </div>

      <HelpModal
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title="Time Tracking Guide"
        description="Learn how to properly log your hours."
      >
        <div>
          <h4 className="font-semibold text-slate-800 mb-2 border-b pb-1">Daily Sequence</h4>
          <ol className="list-decimal list-inside space-y-2 mb-4">
            <li><strong>Clock In:</strong> Start your day when you arrive.</li>
            <li><strong>Lunch Out:</strong> Clock out when you take your mandatory 30-minute break.</li>
            <li><strong>Lunch In:</strong> Clock back in after your break.</li>
            <li><strong>Clock Out:</strong> End your day when you leave.</li>
          </ol>

          <h4 className="font-semibold text-slate-800 mb-2 border-b pb-1">Common Questions</h4>
          <ul className="list-disc list-inside space-y-2">
            <li><strong>Skipping Lunch:</strong> If approved by your manager, you can use the "Skip Lunch" button after clocking in.</li>
            <li><strong>Forget to clock out?</strong> Your manager will be notified to correct your missed punch, but please try to remember to clock out to ensure accurate pay.</li>
            <li><strong>Offline?</strong> If you lose connection, a banner will appear. Wait until connection returns to submit your time.</li>
          </ul>
        </div>
      </HelpModal>

      {/* Anomaly Confirmation Dialog */}
      <AlertDialog open={!!anomalyWarning} onOpenChange={(open) => {
        if (!open) {
          setAnomalyWarning(null);
          setPendingSubmit(null);
        }
      }}>
        <AlertDialogContent className="rounded-2xl border-indigo-100 shadow-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-indigo-900 text-xl">
              <AlertCircle className="size-6 text-amber-500" />
              Unusual Time Entry
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-600 text-base">
              {anomalyWarning}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-6 gap-3 sm:gap-0">
            <AlertDialogCancel className="rounded-xl font-medium sm:w-1/2">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold sm:w-1/2"
              onClick={() => {
                if (pendingSubmit) {
                  pendingSubmit();
                }
                setAnomalyWarning(null);
                setPendingSubmit(null);
              }}
            >
              Confirm & Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Correction Request Modal */}
      <Dialog open={correctionModalOpen} onOpenChange={setCorrectionModalOpen}>
        <DialogContent className="rounded-2xl border-indigo-100 shadow-2xl max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <FileWarning className="size-5 text-amber-500" />
              Request Correction
            </DialogTitle>
            <DialogDescription>
              Submit a request to have an admin correct your time entry.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label className="text-sm font-semibold">Requested Date</Label>
              <Input
                type="date"
                value={correctionDate || today}
                onChange={(e) => setCorrectionDate(e.target.value)}
                className="mt-1.5 rounded-xl"
              />
            </div>

            <div>
              <Label className="text-sm font-semibold">Issue Type</Label>
              <Select value={correctionIssueType} onValueChange={setCorrectionIssueType}>
                <SelectTrigger className="mt-1.5 rounded-xl">
                  <SelectValue placeholder="Select issue type…" />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>{type}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-sm font-semibold">Notes <span className="text-red-500">*</span></Label>
              <Textarea
                value={correctionNotes}
                onChange={(e) => setCorrectionNotes(e.target.value)}
                placeholder="Describe the issue in detail…"
                className="mt-1.5 rounded-xl min-h-[80px]"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-sm font-semibold">Requested In</Label>
                <Input type="time" value={correctionRequestedIn} onChange={(e) => setCorrectionRequestedIn(e.target.value)} className="mt-1.5 rounded-xl" />
              </div>
              <div>
                <Label className="text-sm font-semibold">Requested Out</Label>
                <Input type="time" value={correctionRequestedOut} onChange={(e) => setCorrectionRequestedOut(e.target.value)} className="mt-1.5 rounded-xl" />
              </div>
            </div>

            <div>
              <Label className="text-sm font-semibold">Requested Lunch <span className="text-slate-400">(e.g. 12:00 - 12:30 or 'none')</span></Label>
              <Input type="text" value={correctionRequestedLunch} onChange={(e) => setCorrectionRequestedLunch(e.target.value)} className="mt-1.5 rounded-xl" placeholder="Describe requested lunch..." />
            </div>

            <div>
              <Label className="text-sm font-semibold">Suggested Time <span className="text-slate-400">(optional)</span></Label>
              <Input
                type="text"
                value={correctionSuggestedTime}
                onChange={(e) => setCorrectionSuggestedTime(e.target.value)}
                placeholder="Total suggested hours (e.g. 8.5)"
                className="mt-1.5 rounded-xl"
              />
            </div>
          </div>

          <DialogFooter className="mt-4 gap-3 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setCorrectionModalOpen(false)}
              className="rounded-xl"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmitCorrectionRequest}
              disabled={submittingCorrection || !correctionIssueType || !correctionNotes.trim()}
              className="bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-bold"
            >
              {submittingCorrection ? 'Submitting…' : 'Submit Request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}