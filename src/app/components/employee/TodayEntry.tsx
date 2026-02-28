import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs, limit, query, setDoc, Timestamp, updateDoc, where, deleteDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { AlertCircle, ArrowRight, CheckCircle2, Clock, Coffee, History, LogIn, LogOut as LogOutIcon, Zap } from 'lucide-react';

import type { User } from '../../lib/auth';
import type { TimeEntry } from '../../lib/database';
import { dbService } from '../../lib/database';
import { db } from '../../lib/firebase';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Alert, AlertDescription } from '../ui/alert';
import { ProgressStepper } from '../ui/progress-stepper';

// Existing business logic (ported from the previous HTML/JS app)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
import { calculateLunchMinutes, calculateTotalWorkMinutes } from '../../../utils/timeCalculations';
import { calculateDailyOvertimeBreakdown, getWorkWeekStartDate, DEFAULT_WORKWEEK_START_DAY } from '../../../utils/overtimeCalculations';
import { validateClockIn, validateLunchOut, validateLunchIn, validateClockOut } from '../../../utils/timeValidation';
import { checkEntryAccess, getYesterdayDate } from '../../../utils/timeWindows';

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

  const [currentTime, setCurrentTime] = useState('');
  const [liveTime, setLiveTime] = useState('');

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const timeString = now.toTimeString().slice(0, 5);
      setCurrentTime(timeString);
      setLiveTime(now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    void initLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function initLoad() {
    setLoading(true);
    setBlockedMessage(null);

    try {
      // Access rules (same spirit as old app): employees can be blocked by yesterday/time-window rules.
      // Admins bypass; TEST_MODE bypasses locally.
      const isAdmin = user.role === 'admin';
      if (!TEST_MODE && !isAdmin) {
        const yesterdayDate = getYesterdayDate();
        const ySnap = await getDoc(doc(db, 'timeEntries', `${user.uid}_${yesterdayDate}`));
        let yesterdayEntry: any = ySnap.exists() ? ySnap.data() : null;

        const tSnap = await getDoc(doc(db, 'timeEntries', `${user.uid}_${today}`));
        const todayEntryRaw: any = tSnap.exists() ? tSnap.data() : null;

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
      }

      const existingEntry = await dbService.getTimeEntry(user.uid, today);
      setEntry(existingEntry);
    } catch (e) {
      toast.error('Failed to load entry');
    } finally {
      setLoading(false);
    }
  }

  async function submitClockIn() {
    const validation = validateClockIn(currentTime);
    if (!validation.valid) {
      toast.error(validation.message);
      return;
    }

    const now = Timestamp.now();
    const entryId = `${user.uid}_${today}`;
    const workWeekStartDate = getWorkWeekStartDate(today, DEFAULT_WORKWEEK_START_DAY);

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
        createdAt: now,
        createdBy: user.uid,
        updatedAt: now,
        updatedBy: user.uid,
      },
      { merge: true }
    );
  }

  async function submitLunchOut(skip = false) {
    if (!entry?.clockInManual) {
      toast.error('Clock In is required first');
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
    } as any);
  }

  async function submitLunchIn() {
    if (!entry?.lunchOutManual) {
      toast.error('Lunch Out is required first');
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
    } as any);
  }

  async function submitClockOut() {
    if (!entry?.clockInManual) {
      toast.error('Clock In is required first');
      return;
    }

    const validation = validateClockOut(
      currentTime,
      entry.clockInManual,
      entry.skipLunch ? '' : (entry.lunchInManual || '')
    );
    if (!validation.valid) {
      toast.error(validation.message);
      return;
    }

    const now = Timestamp.now();
    const entryId = `${user.uid}_${today}`;

    const lunchMinutes = calculateLunchMinutes(entry.lunchOutManual || '', entry.lunchInManual || '');
    const totalWorkMinutes = calculateTotalWorkMinutes(entry.clockInManual, currentTime, lunchMinutes);
    const ot = calculateDailyOvertimeBreakdown(totalWorkMinutes);

    await updateDoc(doc(db, 'timeEntries', entryId), {
      clockOutManual: currentTime,
      clockOutSubmitted: true,
      clockOutSystemTime: now,
      lunchMinutes,
      totalWorkMinutes,
      regularMinutes: ot.regularMinutes,
      otMinutes: ot.otMinutes,
      doubleTimeMinutes: ot.doubleTimeMinutes,
      dayComplete: true,
      currentStep: 'complete',
      completedAt: now,
      updatedAt: now,
      updatedBy: user.uid,
    } as any);
  }

  async function handleSubmitStep() {
    if (submitting) return;
    if (!currentTime) return;

    setSubmitting(true);
    try {
      if (!entry || entry.currentStep === 0) {
        await submitClockIn();
      } else if (entry.currentStep === 1) {
        await submitLunchOut(false);
      } else if (entry.currentStep === 2) {
        await submitLunchIn();
      } else if (entry.currentStep === 3) {
        await submitClockOut();
      }

      toast.success('Time submitted successfully');
      await initLoad();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to submit time');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSkipLunch() {
    if (submitting) return;
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
    } catch (e: any) {
      toast.error(e?.message || 'Failed to skip lunch');
    } finally {
      setSubmitting(false);
    }
  }

  async function resetToday() {
    if (!confirm('Delete today’s entry? This is intended for testing only.')) return;
    try {
      await deleteDoc(doc(db, 'timeEntries', `${user.uid}_${today}`));
      toast.success('Entry deleted');
      await initLoad();
    } catch {
      toast.error('Failed to delete entry');
    }
  }

  const calculateEstimatedHours = () => {
    if (!entry?.clockInManual) return null;

    const [hours, minutes] = currentTime.split(':').map(Number);
    const currentTimeMs = new Date(today).setHours(hours, minutes, 0, 0);
    const [inHours, inMinutes] = entry.clockInManual.split(':').map(Number);
    const clockInMs = new Date(today).setHours(inHours, inMinutes, 0, 0);

    let totalMs = currentTimeMs - clockInMs;

    if (entry.lunchOutManual && entry.lunchInManual && !entry.skipLunch) {
      const [lunchOutH, lunchOutM] = entry.lunchOutManual.split(':').map(Number);
      const [lunchInH, lunchInM] = entry.lunchInManual.split(':').map(Number);
      const lunchMs = new Date(today).setHours(lunchInH, lunchInM, 0, 0) - new Date(today).setHours(lunchOutH, lunchOutM, 0, 0);
      totalMs -= lunchMs;
    }

    const totalHours = totalMs / (1000 * 60 * 60);
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
    const step = entry?.currentStep || 0;

    if (entry?.complete) {
      return (
        <div className="space-y-4">
          <Alert className="bg-green-50 border-green-200">
            <CheckCircle2 className="size-5 text-green-600" />
            <AlertDescription className="text-green-900 ml-2">
              Today's entry complete! Contact your manager for corrections.
            </AlertDescription>
          </Alert>

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

          <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-700">Total Hours</span>
              <span className="text-3xl font-bold text-blue-600">{entry.totalHours?.toFixed(2)}</span>
            </div>
          </div>

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
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="size-5 text-blue-600" />
              <span className="text-sm text-slate-600">Current Time</span>
            </div>
            <p className="text-2xl font-bold text-blue-600">{liveTime}</p>
          </div>
          {estimatedHours !== null && estimatedHours > 0 && (
            <div className="mt-2 pt-2 border-t border-blue-200 flex items-center justify-between">
              <span className="text-xs text-slate-600">Hours so far</span>
              <span className="text-lg font-bold text-blue-600">{estimatedHours.toFixed(1)} hrs</span>
            </div>
          )}
        </div>

        {/* Time Input */}
        <div className="space-y-2">
          <Label htmlFor="time" className="flex items-center gap-2">
            <CurrentIcon className="size-4" />
            Enter {stepLabels[step]} Time
          </Label>
          <Input
            id="time"
            type="time"
            value={currentTime}
            onChange={(e) => setCurrentTime(e.target.value)}
            className="h-14 text-lg text-center font-bold"
          />
          <Button
            onClick={() => {
              const now = new Date();
              const timeString = now.toTimeString().slice(0, 5);
              setCurrentTime(timeString);
            }}
            variant="outline"
            size="sm"
            className="w-full"
          >
            <Zap className="size-3 mr-2" />
            Use Current Time
          </Button>
        </div>

        {/* Submit Button */}
        <Button
          onClick={handleSubmitStep}
          className="w-full h-12 bg-blue-600 hover:bg-blue-700"
          disabled={!currentTime || submitting || !!blockedMessage}
        >
          <CurrentIcon className="size-5 mr-2" />
          Submit {stepLabels[step]}
          <ArrowRight className="size-4 ml-2" />
        </Button>

        {step === 1 && (
          <Button
            onClick={handleSkipLunch}
            variant="outline"
            className="w-full"
            disabled={submitting || !!blockedMessage}
          >
            <Coffee className="size-4 mr-2" />
            Skip Lunch Break
          </Button>
        )}
      </div>
    );
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
  const progress = (currentStep / 4) * 100;

  const stepperSteps = [
    { id: 'clock-in', label: 'Clock In' },
    { id: 'lunch-out', label: 'Lunch Out' },
    { id: 'lunch-in', label: entry?.skipLunch ? 'Skipped' : 'Lunch In' },
    { id: 'clock-out', label: 'Clock Out' },
  ];

  return (
    <div className="space-y-6 pb-24">
      {blockedMessage && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription className="ml-2">
            {blockedMessage}
          </AlertDescription>
        </Alert>
      )}

      {/* Progress Stepper */}
      <Card className="border-2 border-primary/20">
        <CardContent className="pt-6 pb-6">
          <ProgressStepper
            steps={stepperSteps}
            currentStep={entry?.complete ? 4 : currentStep}
          />
        </CardContent>
      </Card>

      {/* Current Step Card */}
      <Card className="border-2 border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            {entry?.complete ? (
              <>
                <CheckCircle2 className="size-5 text-green-600" />
                Entry Complete
              </>
            ) : (
              <>
                <ArrowRight className="size-5 text-blue-600" />
                {steps[currentStep]?.label || 'Clock In'}
              </>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {renderStepForm()}
        </CardContent>
      </Card>

      {/* View History Button - Fixed at bottom */}
      <div className="fixed bottom-4 left-0 right-0 px-4 z-10 max-w-4xl mx-auto">
        <Button
          variant="outline"
          onClick={onViewHistory}
          className="w-full h-12 bg-card shadow-lg border-2"
        >
          <History className="size-5 mr-2" />
          View History
        </Button>
      </div>
    </div>
  );
}