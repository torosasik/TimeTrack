import { useEffect, useState, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { Loader2, ClipboardList, Save } from 'lucide-react';

import type { User } from '../../lib/auth';
import { dbService, type TimeEntry } from '../../lib/database';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { getLocalDate, subtractLocalDays, getEmployeeTimezone } from '../../../utils/timeCalculations';
import { formatDateShortWithWeekday } from '../../../utils/dateHelpers.js';

interface DailyReportsEditModalProps {
  user: User;
  open: boolean;
  onClose: () => void;
}

const DAILY_REPORT_MAX = 250;

/**
 * Edit Daily Reports modal (Remote employees only — the parent renders the
 * trigger conditionally). Lists the employee's shifts over a rolling 14-day
 * window (independent of the page's active date filter) and lets them edit
 * each day's `dailyReport` directly.
 *
 * Writes go through `dbService.updateDailyReport`, which enforces the payroll
 * lock and writes an immutable auditLogs row before mutating — the sanctioned
 * correction path for a historical day doc (AGENTS.md audit requirement). NO
 * correction request ticket, NO admin approval (unlike the TimeAdjustmentModal
 * time-editing flows), since the note is not pay-affecting.
 *
 * Only single-doc days are editable here: each row maps to one real Firestore
 * doc id (`${uid}_${date}`), so edits always target a persisted document. Days
 * are sorted newest-first to match the rest of the app.
 */
export function DailyReportsEditModal({ user, open, onClose }: DailyReportsEditModalProps) {
  // Employee's local timezone drives the 14-day window and date display —
  // entry workDate values are local calendar dates per the local-time refactor.
  const employeeTz = useMemo(() => getEmployeeTimezone(user.timezone), [user.timezone]);

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // Draft text per doc id, keyed so edits don't mutate the loaded entries.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Per-row saving state so a save spinner shows on the affected row only.
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Rolling 14-day window in the employee's LOCAL zone (entry dates are
      // local calendar dates). Independent of the page's period filter.
      const today = getLocalDate(employeeTz);
      const start = subtractLocalDays(today, 13, employeeTz); // 14 days inclusive
      const data = await dbService.getTimeEntriesForUserInRange(user.uid, start, today);
      // Hide soft-deleted docs; sort newest-first (getTimeEntriesForUserInRange
      // already returns workDate desc, but re-assert defensively).
      const active = data
        .filter((e) => e.status !== 'voided' && e.status !== 'archived')
        .sort((a, b) => b.date.localeCompare(a.date));
      setEntries(active);
      // Seed drafts from the persisted values.
      const seed: Record<string, string> = {};
      for (const e of active) seed[e.id] = e.dailyReport ?? '';
      setDrafts(seed);
    } catch (e: unknown) {
      toast.error('Failed to load daily reports: ' + ((e as Error).message || String(e)));
    } finally {
      setLoading(false);
    }
  }, [user.uid, employeeTz]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) load();
  }, [open, load]);

  const setDraft = (id: string, value: string) =>
    setDrafts((prev) => ({ ...prev, [id]: value.slice(0, DAILY_REPORT_MAX) }));

  const isDirty = (entry: TimeEntry) =>
    (drafts[entry.id] ?? '') !== (entry.dailyReport ?? '');

  const saveRow = async (entry: TimeEntry) => {
    const value = (drafts[entry.id] ?? '').slice(0, DAILY_REPORT_MAX);
    setSavingId(entry.id);
    try {
      // Route through dbService so the edit enforces the payroll lock and
      // writes an immutable audit row (the sanctioned correction path for a
      // historical day doc) — no raw updateDoc, no correction ticket.
      await dbService.updateDailyReport(entry.id, value, user);
      // Reflect the saved value in the loaded entry so isDirty resets.
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, dailyReport: value } : e)));
      toast.success('Daily report saved');
    } catch (e: unknown) {
      toast.error('Failed to save report: ' + ((e as Error).message || String(e)));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-full max-w-[calc(100%-2rem)] sm:max-w-[1216px] mx-4 max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="size-5" />
            Edit Daily Reports
          </DialogTitle>
          <DialogDescription>
            Last 14 days — older entries are read-only.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 -mx-1 px-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-slate-500 py-6 text-center">No shifts in the last 14 days.</p>
          ) : (
            <div className="w-full rounded-lg border border-slate-200 bg-white overflow-hidden">
              {/* Header row */}
              <div className="flex items-center px-3 py-2 border-b border-slate-200 bg-slate-100/60">
                <span className="w-28 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Date</span>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Daily Report</span>
              </div>
              <div className="divide-y divide-slate-100">
                {entries.map((entry) => {
                  const draft = drafts[entry.id] ?? '';
                  const dirty = isDirty(entry);
                  const saving = savingId === entry.id;
                  return (
                    <div key={entry.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="w-28 shrink-0 text-xs text-slate-600 whitespace-nowrap">
                        {formatDateShortWithWeekday(entry.date)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <Textarea
                          value={draft}
                          onChange={(e) => setDraft(entry.id, e.target.value)}
                          placeholder="No report logged"
                          maxLength={DAILY_REPORT_MAX}
                          rows={2}
                          disabled={saving}
                          className="text-sm placeholder:text-slate-300"
                        />
                      </div>
                      {/* Actions column: counter stacked above Save, both
                          right-aligned — keeps the row single-level and compact. */}
                      <div className="shrink-0 flex flex-col items-end justify-center gap-1">
                        <span className={`text-[11px] tabular-nums ${draft.length >= DAILY_REPORT_MAX ? 'text-rose-600 font-medium' : 'text-muted-foreground'}`}>
                          {draft.length} / {DAILY_REPORT_MAX}
                        </span>
                        <Button
                          size="sm"
                          variant={dirty ? 'default' : 'outline'}
                          onClick={() => saveRow(entry)}
                          disabled={!dirty || saving}
                          className="h-7 text-xs"
                        >
                          {saving ? (
                            <Loader2 className="size-3.5 mr-1 animate-spin" />
                          ) : (
                            <Save className="size-3.5 mr-1" />
                          )}
                          {saving ? 'Saving…' : 'Save'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
