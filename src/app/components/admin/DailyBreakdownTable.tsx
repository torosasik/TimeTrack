/**
 * DailyBreakdownTable — the per-employee Daily Breakdown grid for the
 * Analytics report, with Admin Bulk Edit mode.
 *
 * BULK EDIT MODE (admin-only):
 * - Toggle via the "Bulk Edit" button in the section header.
 * - Renders a sticky action bar (Cancel / Save All Changes) inside the card.
 * - No audit reason/note is collected — per the 2026-08 policy, admin
 *   corrections are exempt from the mandatory audit reason. An immutable
 *   auditLogs row is still written for every mutated doc (empty reason).
 * - Time cells become editable HH:MM inputs (light grey pills); modified
 *   cells and recalculated metric cells highlight light amber; invalid
 *   cells highlight red and block the Save button.
 * - The Flags column is temporarily replaced by an Actions column
 *   (delete-shift trash icon; a "+ Add Shift" button appears per day).
 * - Multi-shift days auto-expand on entering the mode.
 *
 * WRITE-BACK MODEL:
 * The report renders cross-midnight EXPLODED rows (synthetic
 * `${sourceId}@${date}` docs) whose `segments[]` are a subset of the
 * persisted doc's segments (only those attributed to that local date). On
 * save, drafts are grouped by the persisted source id (`writeDocId`) and
 * merged back into the source doc's full segments[]: segments the admin
 * edited or deleted are replaced/removed IN PLACE (matched by segment id);
 * segments attributed to other local dates are untouched; added shifts are
 * appended. System epochs are recomputed via recomputeSegmentSystemTimestamps
 * and totals via recalculateEntryTotals (the canonical SSOT helpers).
 */

import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc, updateDoc, Timestamp } from 'firebase/firestore';
import type { DocumentData } from 'firebase/firestore';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2 } from 'lucide-react';

import { db } from '../../lib/firebase';
import { dbService, type TimeSegment } from '../../lib/database';
import {
  recomputeSegmentSystemTimestamps,
  recalculateEntryTotals,
  stripUndefined,
  computeSegmentWorkMinutes,
} from '../../lib/database';
import {
  validateSegmentChronology,
  getFuturePunchError,
  getSegmentOverlapError,
} from '../../../utils/timeValidation';
import { calculateLunchMinutes } from '../../../utils/timeCalculations';
import {
  calculateDailyOvertimeBreakdown,
  calculateWeeklyOvertimeAdjustments,
  formatMinutesToHHMM,
  getWorkWeekStartDate,
  DEFAULT_WORKWEEK_START_DAY,
  type OvertimeEntry,
} from '../../../utils/overtimeCalculations';
import type { WorkModelOverride } from '../../lib/auth';
import { auditLogService } from '../../../services/auditLogService';
import { writeDocId } from '../../../utils/timeView';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import type { User } from '../../lib/auth';
import type { WorkModel as WorkModelDef } from '../../../services/workModelsService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One editable cell field (manual HH:MM) on a shift. */
type EditField = 'clockInManual' | 'lunchOutManual' | 'lunchInManual' | 'clockOutManual';

/** Editable draft of a single shift (segment). */
interface DraftSegment {
  /** Stable key: persisted segment id, or a fresh `seg_new_*` key for adds. */
  key: string;
  clockInManual: string;
  lunchOutManual: string;
  lunchInManual: string;
  clockOutManual: string;
  skipLunch: boolean;
  /** true when this row was added during bulk edit (not persisted yet). */
  isNew: boolean;
  /** true when the admin marked this persisted shift for deletion. */
  deleted: boolean;
  /** Original values (times + skip flag), for modified-cell highlighting and
      the clean/dirty evaluation. */
  orig: { clockInManual: string; lunchOutManual: string; lunchInManual: string; clockOutManual: string; skipLunch: boolean };
  /** Lunch values captured when skip-lunch was toggled ON, restored exactly
      when it is toggled back OFF (so on→off returns the row to pristine). */
  preSkipLunch?: { lunchOutManual: string; lunchInManual: string };
  /**
   * The persisted pipeline data this draft came from: the segment for normal
   * rows, or the whole DAY doc for legacy segment-less rows (whose root-level
   * fields carry the shift data). Undefined only for shifts ADDED during bulk
   * edit. Carries the epoch-derived `workMinutes` so the live preview matches
   * the read-only report exactly for UNEDITED segments (the HH:MM strings are
   * minute-truncated and would drift the recomputed day total by up to ±1 min
   * per shift).
   */
  source?: TimeSegment;
}

/** Editable draft of one breakdown row (a day, possibly a synthetic part). */
interface DraftDay {
  rowKey: string;
  workDate: string;
  /** Persisted Firestore doc id this row's shifts write back to. */
  sourceId: string;
  /** Employee-local anchor date used to derive epochs for this row's shifts. */
  anchorDate: string;
  segments: DraftSegment[];
}

export interface DailyBreakdownTableProps {
  /** The expanded employee summary row this breakdown belongs to. */
  summary: {
    userId: string;
    userName: string;
    workModel: string;
    /** Direct HH:MM duration strings from the OT pipeline (display-only here). */
    regularHours: string;
    overtimeHours: string;
    doubleTimeHours: string;
    totalHours: string;
    dailyEntries?: DocumentData[];
  };
  /** The signed-in user (must be admin for Bulk Edit to appear). */
  currentUser: User;
  /** Employee IANA timezone — manual HH:MM strings live in this zone. */
  employeeTimezone?: string;
  /** Resolved work-model definition (drives per-user OT thresholds). */
  workModelDef?: WorkModelDef | null;
  /** Per-user work-model override (wins over workModelDef; mirrors the
      Analytics/Payroll pipeline's `userObj.workModelOverride`). */
  workModelOverride?: WorkModelOverride | null;
  /** Called after a successful batch save so the parent can regenerate. */
  onSaved: () => void;
  /**
   * Reports the live preview totals up to the parent while bulk-editing
   * (so the employee summary card can update dynamically before save).
   * Called with `null` when bulk edit exits (cancel or save).
   */
  onLiveTotals?: (totals: { regularHours: string; overtimeHours: string; doubleTimeHours: string; totalHours: string } | null) => void;
  /** Render helpers injected by the parent (display-zone aware). */
  renderParentBoundary: (day: DocumentData, which: 'in' | 'out') => JSX.Element;
  renderParentLunch: (day: DocumentData, which: 'out' | 'in') => JSX.Element;
  renderSegBoundary: (seg: DocumentData, field: EditField) => JSX.Element;
  /** Parent row flag chips + per-segment flag chips (read mode only). */
  renderParentFlags: (day: DocumentData) => JSX.Element | null;
  renderSegFlags: (day: DocumentData, index: number) => JSX.Element | null;
  /** Format a YYYY-MM-DD with weekday for the Date column. */
  formatDate: (ymd: string) => string;
  /** True when a day row has >1 shifts (drives the expander chevron). */
  isMultiShift: (day: DocumentData) => boolean;
  /** Segments of a day (empty array for legacy docs). */
  segmentsOf: (day: DocumentData) => DocumentData[];
}

// ---------------------------------------------------------------------------
// Pure helpers (module scope so they are jest-friendly + never re-created)
// ---------------------------------------------------------------------------

let newSegCounter = 0;
function freshDraft(): DraftSegment {
  newSegCounter += 1;
  return {
    key: `seg_new_${Date.now()}_${newSegCounter}`,
    clockInManual: '',
    lunchOutManual: '',
    lunchInManual: '',
    clockOutManual: '',
    skipLunch: false,
    isNew: true,
    deleted: false,
    orig: { clockInManual: '', lunchOutManual: '', lunchInManual: '', clockOutManual: '', skipLunch: false },
  };
}

function segToDraft(s: DocumentData): DraftSegment {
  return {
    key: String(s.id ?? `seg_${Math.random().toString(36).slice(2, 9)}`),
    clockInManual: s.clockInManual ?? '',
    lunchOutManual: s.lunchOutManual ?? '',
    lunchInManual: s.lunchInManual ?? '',
    clockOutManual: s.clockOutManual ?? '',
    skipLunch: s.skipLunch === true,
    isNew: false,
    deleted: false,
    orig: {
      clockInManual: s.clockInManual ?? '',
      lunchOutManual: s.lunchOutManual ?? '',
      lunchInManual: s.lunchInManual ?? '',
      clockOutManual: s.clockOutManual ?? '',
      skipLunch: s.skipLunch === true,
    },
    // Full persisted segment (epoch systems + stored workMinutes) so the live
    // preview can reuse the canonical epoch-precision minutes for UNEDITED
    // segments instead of recomputing from the minute-truncated HH:MM strings
    // (which loses the punch seconds and drifts the day total by ±1 min).
    source: s as TimeSegment,
  };
}

/** HH:MM format check (24h, 00:00–23:59). */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isModified(seg: DraftSegment, field: EditField): boolean {
  return seg[field] !== seg.orig[field];
}

/**
 * True when any editable value (a time field OR the skip-lunch flag) differs
 * from its original. skipLunch is included so a skip-only change counts as a
 * modification (it must persist), while a skip on→off round-trip returns the
 * row to pristine (every field back to orig → not dirty).
 */
function isDraftModified(s: DraftSegment): boolean {
  return (
    isModified(s, 'clockInManual') ||
    isModified(s, 'lunchOutManual') ||
    isModified(s, 'lunchInManual') ||
    isModified(s, 'clockOutManual') ||
    s.skipLunch !== s.orig.skipLunch
  );
}

/** Minutes-of-day for HH:MM, NaN when invalid/empty. */
function mins(t: string): number {
  if (!HHMM_RE.test(t)) return NaN;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Per-cell validation for a draft segment. Wraps the canonical
 * cross-midnight-aware validateSegmentChronology and maps its messages back
 * onto the specific input cells so the offending field can be tinted red.
 * Open shifts (no clock-out yet) are validated with allowOpen.
 */
function validateDraftSegment(seg: DraftSegment): Map<EditField, string> {
  const errs = new Map<EditField, string>();
  const { clockInManual: ci, lunchOutManual: lo, lunchInManual: li, clockOutManual: co } = seg;

  // Format-level errors first (chronology helper can't parse non-HH:MM).
  for (const [field, v] of [['clockInManual', ci], ['lunchOutManual', lo], ['lunchInManual', li], ['clockOutManual', co]] as [EditField, string][]) {
    if (v && !HHMM_RE.test(v)) errs.set(field, 'Invalid time (HH:MM)');
  }
  if (errs.size > 0) return errs;

  if (!ci) {
    // A shift without a clock-in is invalid (except a brand-new untouched row
    // is still invalid too — the admin must fill Clock In before saving).
    errs.set('clockInManual', 'Clock in is required');
    return errs;
  }

  const chronoErrs = validateSegmentChronology(
    {
      clockInManual: ci,
      lunchOutManual: seg.skipLunch ? '' : lo,
      lunchInManual: seg.skipLunch ? '' : li,
      clockOutManual: co,
      skipLunch: seg.skipLunch,
    },
    { allowOpen: !co },
  );

  for (const msg of chronoErrs) {
    if (/Clock out must be after clock in/i.test(msg)) errs.set('clockOutManual', msg);
    else if (/Lunch out must be after clock in/i.test(msg)) errs.set('lunchOutManual', msg);
    else if (/Lunch in must be after lunch out/i.test(msg)) errs.set('lunchInManual', msg);
    else if (/Lunch out must be before clock out/i.test(msg)) errs.set('lunchOutManual', msg);
    else if (/Lunch in must be before clock out/i.test(msg)) errs.set('lunchInManual', msg);
    else if (/Both lunch times required/i.test(msg)) {
      if (lo && !li) errs.set('lunchInManual', msg);
      else errs.set('lunchOutManual', msg);
    } else if (/Clock out is required/i.test(msg)) errs.set('clockOutManual', msg);
  }
  return errs;
}

/**
 * Live metric recalculation for a draft day's visible (non-deleted) shifts:
 * per-segment minutes → day total → daily OT buckets. Open segments
 * (no clock-out) contribute their manual-derived minutes when computable.
 *
 * The employee's resolved work model is threaded through so the per-day
 * Reg/OT/DT preview matches BOTH the weekly summary preview AND the
 * post-save report (previously this used bare CA defaults, which made the
 * day cells disagree with the summary card for non-default work models).
 */
function draftDayTotals(
  day: DraftDay,
  workModelDef?: WorkModelDef | null,
  workModelOverride?: WorkModelOverride | null,
): { totalWorkMinutes: number; regularMinutes: number; otMinutes: number; doubleTimeMinutes: number } {
  const live = day.segments.filter(s => !s.deleted);
  let total = 0;
  for (const s of live) {
    // UNEDITED persisted segment: reuse the canonical read-side calculator,
    // which keeps the stored/epoch-derived workMinutes (punch-second
    // precision) — the exact value the read-only report displays. The manual
    // HH:MM strings are minute-truncated and would drift the day total by up
    // to ±1 min per shift (the 8:56-vs-8:55 discrepancy).
    const edited =
      !s.source ||
      s.isNew ||
      s.clockInManual !== s.orig.clockInManual ||
      s.lunchOutManual !== s.orig.lunchOutManual ||
      s.lunchInManual !== s.orig.lunchInManual ||
      s.clockOutManual !== s.orig.clockOutManual;
    if (!edited && s.source) {
      total += computeSegmentWorkMinutes(s.source);
      continue;
    }
    // Edited / added / legacy-synthesized segment: recompute from the manual
    // strings (matches the write path's post-edit recalculation).
    if (!s.clockInManual || !s.clockOutManual) continue;
    const inM = mins(s.clockInManual);
    let outM = mins(s.clockOutManual);
    if (Number.isNaN(inM) || Number.isNaN(outM)) continue;
    if (outM < inM) outM += 24 * 60; // S6 cross-midnight wrap
    let work = Math.max(0, outM - inM);
    if (!s.skipLunch && s.lunchOutManual && s.lunchInManual) {
      let loM = mins(s.lunchOutManual);
      let liM = mins(s.lunchInManual);
      if (!Number.isNaN(loM) && !Number.isNaN(liM)) {
        if (loM < inM) loM += 24 * 60;
        if (liM < inM) liM += 24 * 60;
        work = Math.max(0, work - Math.max(0, liM - loM));
      }
    }
    total += work;
  }
  const daily = calculateDailyOvertimeBreakdown(total, workModelDef ?? null, workModelOverride ?? null);
  return { totalWorkMinutes: total, ...daily };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DailyBreakdownTable({
  summary,
  currentUser,
  employeeTimezone,
  workModelDef,
  workModelOverride,
  onSaved,
  onLiveTotals,
  renderParentBoundary,
  renderParentLunch,
  renderSegBoundary,
  renderParentFlags,
  renderSegFlags,
  formatDate,
  isMultiShift,
  segmentsOf,
}: DailyBreakdownTableProps) {
  const isAdmin = currentUser.role === 'admin';
  const dailyEntries = useMemo(() => summary.dailyEntries ?? [], [summary.dailyEntries]);

  // --- Bulk edit state -----------------------------------------------------
  const [bulkEdit, setBulkEdit] = useState(false);
  const [drafts, setDrafts] = useState<Map<string, DraftDay>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  // Captured when Bulk Edit is entered (an event) — used as the "now" anchor
  // for the live future-punch check. Not refreshed during render (Date.now()
  // is impure inside useMemo); the save path re-checks with a fresh Date.now().
  const [editNowMs, setEditNowMs] = useState<number>(0);

  // Build the editable working copy from the pipeline entries. Called by
  // enterBulkEdit (an event handler) — NOT a memo gated on `bulkEdit`, which
  // was the original bug: the memo returned [] while bulkEdit was still false,
  // so entering edit mode produced an empty drafts map and zero rows.
  const buildDrafts = (): Map<string, DraftDay> => {
    const map = new Map<string, DraftDay>();
    for (const day of dailyEntries) {
      const segs = segmentsOf(day);
      // Legacy doc without segments[]: synthesize one draft from root fields.
      const draftSegs = segs.length > 0
        ? segs.map(segToDraft)
        : [segToDraft(day)];
      const d: DraftDay = {
        rowKey: String(day.id ?? day.workDate),
        workDate: String(day.workDate ?? day.date ?? ''),
        sourceId: writeDocId(day),
        anchorDate: String(day.workDate ?? day.date ?? ''),
        segments: draftSegs,
      };
      map.set(d.rowKey, d);
    }
    return map;
  };

  const dirty = useMemo(
    () =>
      drafts.size > 0 &&
      [...drafts.values()].some(d =>
        d.segments.some(s => (s.deleted || s.isNew ? true : isDraftModified(s))),
      ),
    [drafts],
  );

  const errors = useMemo(() => {
    const m = new Map<string, string>();
    const nowMs = editNowMs;
    for (const d of drafts.values()) {
      const live = d.segments.filter(s => !s.deleted);
      // Resolve each draft's manual HH:MM to epochs (pure helper) so the
      // future + overlap guards — which operate on instants — can run live.
      const epochSegs = new Map<string, TimeSegment>();
      for (const s of live) {
        if (!HHMM_RE.test(s.clockInManual)) continue; // format errors already flagged
        const seg = recomputeSegmentSystemTimestamps(
          {
            id: s.key,
            clockInManual: s.clockInManual,
            lunchOutManual: s.skipLunch ? '' : s.lunchOutManual,
            lunchInManual: s.skipLunch ? '' : s.lunchInManual,
            clockOutManual: s.clockOutManual,
            skipLunch: s.skipLunch,
            complete: !!s.clockOutManual,
          },
          d.anchorDate,
          employeeTimezone,
        );
        epochSegs.set(s.key, seg);
      }

      for (const s of live) {
        // 1) Per-cell format + chronology (existing).
        for (const [field, msg] of validateDraftSegment(s)) {
          m.set(`${d.rowKey}|${s.key}|${field}`, msg);
        }
        // 2) Future-punch guard — flag the specific cell(s) whose epoch is
        //    ahead of now (mirrors getFuturePunchError's field scan).
        const es = epochSegs.get(s.key);
        if (es) {
          const futureFields: [EditField, number | undefined][] = [
            ['clockInManual', es.clockInSystem],
            ['lunchOutManual', es.lunchOutSystem],
            ['lunchInManual', es.lunchInSystem],
            ['clockOutManual', es.clockOutSystem],
          ];
          for (const [field, v] of futureFields) {
            const k = `${d.rowKey}|${s.key}|${field}`;
            if (!m.has(k) && typeof v === 'number' && v > nowMs) {
              m.set(k, 'Time cannot be in the future');
            }
          }
        }
      }

      // 3) Same-day overlap guard — double-counted payroll. Mark the Clock In
      //    cell of every segment in the overlapping set (the precise pair is
      //    not identifiable from the string message, so flag all participants
      //    on that day when more than one complete interval exists).
      const completeSegs = live.filter(s => {
        const es = epochSegs.get(s.key);
        return es && typeof es.clockInSystem === 'number' && typeof es.clockOutSystem === 'number';
      });
      if (completeSegs.length > 1) {
        const overlapMsg = getSegmentOverlapError(
          completeSegs.map(s => epochSegs.get(s.key)!),
        );
        if (overlapMsg) {
          for (const s of completeSegs) {
            const k = `${d.rowKey}|${s.key}|clockInManual`;
            if (!m.has(k)) m.set(k, 'Shifts on this day overlap');
          }
        }
      }
    }
    return m;
  }, [drafts, employeeTimezone, editNowMs]);

  const hasErrors = errors.size > 0;

  // Live recalculated per-day metrics, keyed by rowKey.
  const liveTotals = useMemo(() => {
    const m = new Map<string, ReturnType<typeof draftDayTotals>>();
    for (const d of drafts.values()) m.set(d.rowKey, draftDayTotals(d, workModelDef, workModelOverride));
    return m;
  }, [drafts, workModelDef, workModelOverride]);

  // Live summary-card totals: recompute the WHOLE employee range through the
  // canonical weekly-OT pipeline with edited days swapped in, so the summary
  // numbers stay payroll-accurate (weekly >40h adjustments included).
  const liveSummary = useMemo(() => {
    if (!bulkEdit || drafts.size === 0) return null;
    const otEntries: OvertimeEntry[] = dailyEntries.map((day) => {
      const d = drafts.get(String(day.id ?? day.workDate));
      if (!d) return day as OvertimeEntry; // untouched day keeps pipeline values
      const t = liveTotals.get(d.rowKey)!;
      return {
        ...day,
        totalWorkMinutes: t.totalWorkMinutes,
        regularMinutes: undefined,
        otMinutes: undefined,
        doubleTimeMinutes: undefined,
        weeklyOtAdjustment: undefined,
      } as OvertimeEntry;
    });
    const byWeek = new Map<string, OvertimeEntry[]>();
    for (const e of otEntries) {
      const ws = getWorkWeekStartDate(e.workDate, DEFAULT_WORKWEEK_START_DAY);
      if (!byWeek.has(ws)) byWeek.set(ws, []);
      byWeek.get(ws)!.push(e);
    }
    let reg = 0, ot = 0, dt = 0, tot = 0;
    for (const weekEntries of byWeek.values()) {
      const adj = calculateWeeklyOvertimeAdjustments(weekEntries, workModelDef ?? null, workModelOverride ?? null);
      for (const e of adj) {
        reg += e.regularMinutes || 0;
        ot += e.otMinutes || 0;
        dt += e.doubleTimeMinutes || 0;
        tot += e.totalWorkMinutes || 0;
      }
    }
    // Direct HH:MM outputs (same format as the pipeline summary strings).
    return {
      regularHours: formatMinutesToHHMM(reg),
      overtimeHours: formatMinutesToHHMM(ot),
      doubleTimeHours: formatMinutesToHHMM(dt),
      totalHours: formatMinutesToHHMM(tot),
    };
  }, [bulkEdit, drafts, dailyEntries, liveTotals, workModelDef, workModelOverride]);

  // Report the live preview totals up to the parent summary card while
  // editing; clear them when bulk edit exits so the card reverts to the
  // persisted pipeline values.
  useEffect(() => {
    if (!onLiveTotals) return;
    onLiveTotals(bulkEdit ? liveSummary : null);
    return () => onLiveTotals(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkEdit, liveSummary]);

  // --- Mode transitions ----------------------------------------------------

  const enterBulkEdit = () => {
    setDrafts(buildDrafts());
    setEditNowMs(Date.now()); // anchor for the live future-punch check
    // Auto-expand every multi-shift day so child shifts are editable.
    const auto = new Set<string>();
    for (const day of dailyEntries) {
      if (isMultiShift(day)) auto.add(String(day.id ?? day.workDate));
    }
    setExpanded(auto);
    setBulkEdit(true);
  };

  const cancelBulkEdit = () => {
    setBulkEdit(false);
    setDrafts(new Map());
    setExpanded(new Set());
  };

  // --- Cell mutation ---------------------------------------------------------

  // Refresh the "now" anchor used by the live future-punch check. Called from
  // every draft-mutation EVENT (never during render). The lazy-updater form
  // keeps the impure Date.now() inside the state update, which React's
  // compiler recognizes as event-time (not render-time).
  const touchNow = () => setEditNowMs(() => Date.now());

  const updateCell = (dayKey: string, segKey: string, field: EditField, value: string) => {
    touchNow();
    setDrafts(prev => {
      const next = new Map(prev);
      const day = next.get(dayKey);
      if (!day) return prev;
      next.set(dayKey, {
        ...day,
        segments: day.segments.map(s => (s.key === segKey ? { ...s, [field]: value } : s)),
      });
      return next;
    });
  };

  const toggleSkipLunch = (dayKey: string, segKey: string, checked: boolean) => {
    touchNow();
    setDrafts(prev => {
      const next = new Map(prev);
      const day = next.get(dayKey);
      if (!day) return prev;
      next.set(dayKey, {
        ...day,
        segments: day.segments.map(s => {
          if (s.key !== segKey) return s;
          if (checked) {
            // ON: stash the current lunch values, then blank them (skipped
            // lunch has no punch times).
            return {
              ...s,
              skipLunch: true,
              preSkipLunch: { lunchOutManual: s.lunchOutManual, lunchInManual: s.lunchInManual },
              lunchOutManual: '',
              lunchInManual: '',
            };
          }
          // OFF: restore the stashed lunch values (fall back to the persisted
          // originals). Toggling on→off with no other edits returns every
          // field to its original value, so the row evaluates pristine.
          return {
            ...s,
            skipLunch: false,
            lunchOutManual: s.preSkipLunch?.lunchOutManual ?? s.orig.lunchOutManual,
            lunchInManual: s.preSkipLunch?.lunchInManual ?? s.orig.lunchInManual,
          };
        }),
      });
      return next;
    });
  };

  const deleteShift = (dayKey: string, segKey: string) => {
    touchNow();
    setDrafts(prev => {
      const next = new Map(prev);
      const day = next.get(dayKey);
      if (!day) return prev;
      // New (not-yet-persisted) rows are simply removed; persisted segments are
      // tombstoned so Cancel can restore them and Save knows what to strip.
      const segs = day.segments.some(s => s.key === segKey && s.isNew)
        ? day.segments.filter(s => s.key !== segKey)
        : day.segments.map(s => (s.key === segKey ? { ...s, deleted: !s.deleted } : s));
      next.set(dayKey, { ...day, segments: segs });
      return next;
    });
  };

  const addShift = (dayKey: string) => {
    touchNow();
    setDrafts(prev => {
      const next = new Map(prev);
      const day = next.get(dayKey);
      if (!day) return prev;
      next.set(dayKey, { ...day, segments: [...day.segments, freshDraft()] });
      return next;
    });
    // Adding a shift to a single-shift day turns it into a multi-shift day —
    // expand it so the new child row is immediately visible/editable.
    setExpanded(prev => new Set(prev).add(dayKey));
  };

  // --- Save ------------------------------------------------------------------

  const saveAll = async () => {
    if (!dirty || hasErrors) return;
    setSaving(true);
    try {
      // Group edited days by their persisted source doc id so cross-midnight
      // parts merge back into the single source doc.
      const byDoc = new Map<string, DraftDay[]>();
      for (const d of drafts.values()) {
        const touched = d.segments.some(s => s.deleted || s.isNew || isDraftModified(s));
        if (!touched) continue;
        if (!byDoc.has(d.sourceId)) byDoc.set(d.sourceId, []);
        byDoc.get(d.sourceId)!.push(d);
      }

      for (const [sourceId, dayDrafts] of byDoc.entries()) {
        const snap = await getDoc(doc(db, 'timeEntries', sourceId));
        if (!snap.exists()) throw new Error(`Entry ${sourceId} no longer exists.`);
        const persisted = snap.data() as DocumentData;

        // GUARD — never mutate voided/archived records. The report pipeline
        // can surface them, and writing status:'corrected' below would
        // silently resurrect a voided entry (soft-delete invariant).
        if (persisted.status === 'voided' || persisted.status === 'archived') {
          throw new Error(
            `Entry ${persisted.workDate ?? persisted.date ?? sourceId} is ${persisted.status} and cannot be edited here. Restore it first.`,
          );
        }

        // GUARD — payroll lock (PT). Check every calendar date the edit
        // touches: the owning doc's date plus each edited day's attributed
        // local date (they differ across a local-midnight split). Same guard
        // as every other correction path (dbService.assertPayrollDatesNotLocked).
        await dbService.assertPayrollDatesNotLocked(
          persisted.date ?? persisted.workDate,
          persisted.workDate,
          ...dayDrafts.map(d => d.anchorDate),
        );

        const beforeSegs: TimeSegment[] = Array.isArray(persisted.segments)
          ? persisted.segments.map((s: DocumentData) => ({ ...s }) as TimeSegment)
          : [];
        const beforeSnapshot = {
          segments: beforeSegs,
          totalWorkMinutes: persisted.totalWorkMinutes,
          totalHours: persisted.totalHours,
        };

        // Edited/deleted/new segments keyed by segment id for this source doc.
        const editedById = new Map<string, DraftSegment>();
        const newSegs: { draft: DraftSegment; anchorDate: string }[] = [];
        for (const d of dayDrafts) {
          for (const s of d.segments) {
            if (s.isNew) {
              if (!s.deleted) newSegs.push({ draft: s, anchorDate: d.anchorDate });
            } else {
              editedById.set(s.key, s);
            }
          }
        }

        // Rebuild the persisted segments[] in place (preserving segments that
        // belong to other local dates and were not part of these rows).
        const rebuilt: TimeSegment[] = [];
        const consumedDraftKeys = new Set<string>();
        for (const ps of beforeSegs) {
          const edit = editedById.get(String(ps.id));
          if (!edit) { rebuilt.push(ps); continue; } // untouched
          consumedDraftKeys.add(edit.key);
          if (edit.deleted) continue; // deleted shift: removed from array
          const dayDraft = dayDrafts.find(d => d.segments.some(s => s.key === edit.key));
          const anchor = dayDraft?.anchorDate ?? persisted.workDate ?? persisted.date;
          const merged: TimeSegment = {
            ...ps,
            clockInManual: edit.clockInManual,
            lunchOutManual: edit.skipLunch ? '' : edit.lunchOutManual,
            lunchInManual: edit.skipLunch ? '' : edit.lunchInManual,
            clockOutManual: edit.clockOutManual,
            skipLunch: edit.skipLunch,
            complete: !!edit.clockOutManual,
            // A cleared manual boundary must not keep its stale system epoch:
            // recomputeSegmentSystemTimestamps only refreshes non-empty
            // manuals, so an emptied clock-out would otherwise linger with
            // yesterday's clockOutSystem instant. stripUndefined drops these
            // keys from the persisted array element.
            ...(edit.skipLunch || !edit.lunchOutManual ? { lunchOutSystem: undefined } : {}),
            ...(edit.skipLunch || !edit.lunchInManual ? { lunchInSystem: undefined } : {}),
            ...(!edit.clockOutManual ? { clockOutSystem: undefined } : {}),
          };
          rebuilt.push(recomputeSegmentSystemTimestamps(merged, anchor, employeeTimezone));
        }
        // Legacy synthesis fallback: a segment-less doc's draft was built from
        // the ROOT fields with the doc id as its key, so it never matched a
        // persisted segment id above. Append any unconsumed non-deleted drafts
        // here so edits to legacy docs are not silently dropped.
        for (const d of dayDrafts) {
          for (const s of d.segments) {
            if (s.isNew || s.deleted || consumedDraftKeys.has(s.key)) continue;
            const seg: TimeSegment = {
              id: `seg_admin_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              clockInManual: s.clockInManual,
              lunchOutManual: s.skipLunch ? '' : s.lunchOutManual,
              lunchInManual: s.skipLunch ? '' : s.lunchInManual,
              clockOutManual: s.clockOutManual,
              skipLunch: s.skipLunch,
              complete: !!s.clockOutManual,
            };
            rebuilt.push(recomputeSegmentSystemTimestamps(seg, d.anchorDate, employeeTimezone));
          }
        }
        for (const { draft, anchorDate } of newSegs) {
          const seg: TimeSegment = {
            id: `seg_admin_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            clockInManual: draft.clockInManual,
            lunchOutManual: draft.skipLunch ? '' : draft.lunchOutManual,
            lunchInManual: draft.skipLunch ? '' : draft.lunchInManual,
            clockOutManual: draft.clockOutManual,
            skipLunch: draft.skipLunch,
            complete: !!draft.clockOutManual,
          };
          rebuilt.push(recomputeSegmentSystemTimestamps(seg, anchorDate, employeeTimezone));
        }

        // Recalculate canonical totals from the rebuilt segments (SSOT).
        const recalc = recalculateEntryTotals(rebuilt);
        const finalSegs = recalc.segments;

        // GUARD (defense-in-depth; the live validation memo already blocks the
        // Save button, but the persisted write re-verifies with fresh epochs):
        // 1) no future timestamps, 2) no same-day overlapping shifts.
        const nowMs = Date.now();
        for (const s of finalSegs) {
          const futureErr = getFuturePunchError(s, nowMs);
          if (futureErr) {
            throw new Error(
              `${persisted.workDate ?? persisted.date ?? sourceId}: ${futureErr}`,
            );
          }
        }
        const overlapErr = getSegmentOverlapError(finalSegs);
        if (overlapErr) {
          throw new Error(
            `${persisted.workDate ?? persisted.date ?? sourceId}: ${overlapErr}`,
          );
        }

        // Daily OT buckets (work-model + override aware) — persisted so
        // single-segment docs' stored buckets stay in sync (the payroll
        // pipeline trusts stored buckets for single-segment docs).
        const dailyOT = calculateDailyOvertimeBreakdown(
          recalc.totalWorkMinutes,
          workModelDef ?? null,
          workModelOverride ?? null,
        );

        const lastClosed = [...finalSegs].reverse().find(s => s.clockOutManual) ?? finalSegs[finalSegs.length - 1];
        const allComplete = finalSegs.length > 0 && finalSegs.every(s => s.complete === true);

        // Audit FIRST (mandatory). Admin edits need no reason (2026-08 policy).
        await auditLogService.logTimeCorrection({
          actorUid: currentUser.uid,
          actorName: currentUser.name,
          actorRole: 'admin',
          targetId: sourceId,
          before: beforeSnapshot,
          after: { segments: finalSegs, totalWorkMinutes: recalc.totalWorkMinutes, totalHours: recalc.totalHours },
          reason: '',
        });

        // Mirror the LAST segment onto the root fields (dual-write invariant:
        // root mirrors the last persisted segment). Every value is coerced to
        // string or null — updateDoc REJECTS undefined (the pre-fix crash: an
        // open last segment has no clockOutSystem and threw, failing the whole
        // save). null explicitly clears a previously-set field (e.g. a shift
        // that went from closed to open clears root clockOutSystem).
        const mirror = lastClosed
          ? {
            clockInManual: lastClosed.clockInManual ?? '',
            clockOutManual: lastClosed.clockOutManual ?? '',
            lunchOutManual: lastClosed.skipLunch ? '' : (lastClosed.lunchOutManual ?? ''),
            lunchInManual: lastClosed.skipLunch ? '' : (lastClosed.lunchInManual ?? ''),
            lunchSkipped: finalSegs.every(s => s.skipLunch === true),
            lunchMinutes: lastClosed.skipLunch
              ? 0
              : calculateLunchMinutes(lastClosed.lunchOutManual ?? '', lastClosed.lunchInManual ?? ''),
            clockInSystem: lastClosed.clockInSystem ?? null,
            clockOutSystem: lastClosed.clockOutSystem ?? null,
            lunchOutSystem: lastClosed.skipLunch ? null : (lastClosed.lunchOutSystem ?? null),
            lunchInSystem: lastClosed.skipLunch ? null : (lastClosed.lunchInSystem ?? null),
            clockInSystemTime: lastClosed.clockInSystem != null ? Timestamp.fromMillis(lastClosed.clockInSystem) : null,
            clockOutSystemTime: lastClosed.clockOutSystem != null ? Timestamp.fromMillis(lastClosed.clockOutSystem) : null,
            lunchOutSystemTime: !lastClosed.skipLunch && lastClosed.lunchOutSystem != null
              ? Timestamp.fromMillis(lastClosed.lunchOutSystem) : null,
            lunchInSystemTime: !lastClosed.skipLunch && lastClosed.lunchInSystem != null
              ? Timestamp.fromMillis(lastClosed.lunchInSystem) : null,
          }
          : null;

        await updateDoc(doc(db, 'timeEntries', sourceId), {
          segments: finalSegs.map(s => stripUndefined(s)),
          totalWorkMinutes: recalc.totalWorkMinutes,
          totalHours: recalc.totalHours,
          regularMinutes: dailyOT.regularMinutes,
          otMinutes: dailyOT.otMinutes,
          doubleTimeMinutes: dailyOT.doubleTimeMinutes,
          ...(mirror ?? {}),
          dayComplete: allComplete,
          complete: allComplete,
          ...(allComplete ? { currentStep: 'complete' } : {}),
          status: 'corrected',
          updatedAt: Timestamp.now(),
          updatedBy: currentUser.uid,
        });
      }

      toast.success('Bulk changes saved (audit trail recorded)');
      cancelBulkEdit();
      onSaved();
    } catch (e: unknown) {
      toast.error((e as Error).message || 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  // --- Rendering helpers -----------------------------------------------------

  const cellErr = (dayKey: string, segKey: string, field: EditField): string | undefined =>
    errors.get(`${dayKey}|${segKey}|${field}`);

  const inputCls = (dayKey: string, seg: DraftSegment, field: EditField): string => {
    // 96px pill so locale time strings with AM/PM render untruncated inside
    // the 110px column. Each variant sets exactly ONE bg class (Tailwind
    // conflicts resolve by stylesheet order, not attribute order, so a base
    // bg-slate-100 + appended bg-amber-100 would be unreliable).
    const base =
      'h-7 w-[96px] rounded border px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400';
    if (cellErr(dayKey, seg.key, field)) return `${base} bg-red-100 border-red-400 text-red-700`;
    if (isModified(seg, field)) return `${base} bg-amber-100 border-amber-400 text-slate-800`;
    return `${base} bg-slate-100 border-slate-300 text-slate-800`;
  };

  const metricCls = (changed: boolean): string =>
    `px-1.5 py-2 align-middle ${changed ? 'bg-amber-100/70' : ''}`;

  const dayDraftChanged = (d: DraftDay): boolean =>
    d.segments.some(s => (s.deleted || s.isNew ? true : isDraftModified(s)));

  // --- Render ----------------------------------------------------------------

  return (
    <div
      className={
        bulkEdit
          ? 'mt-2 pt-2 border-t border-slate-200 overflow-x-auto px-[10px] rounded-md ring-2 ring-indigo-500'
          : 'mt-2 pt-2 border-t border-slate-200 overflow-x-auto px-[10px]'
      }
    >
      {/* Section header + Bulk Edit toggle */}
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-slate-700">Daily Breakdown</p>
        {isAdmin && !bulkEdit && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={enterBulkEdit}>
            Bulk Edit
          </Button>
        )}
      </div>

      {/* Sticky action bar */}
      {bulkEdit && (
        <div className="sticky top-0 z-10 mb-2 flex items-center justify-between gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-indigo-800">Bulk Edit Mode Active</span>
            {dirty && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 border border-amber-200">
                Unsaved Changes
              </span>
            )}
            {hasErrors && (
              <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 border border-red-200">
                {errors.size} invalid cell{errors.size === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs bg-white hover:bg-slate-50 text-slate-700 border-slate-300"
              onClick={cancelBulkEdit}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs bg-indigo-600 hover:bg-indigo-700 text-white"
              onClick={saveAll}
              disabled={!dirty || hasErrors || saving}
            >
              {saving ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
              Save All Changes
            </Button>
          </div>
        </div>
      )}

      <table className="table-fixed w-full text-xs text-left text-slate-600">
        <colgroup>
          {/* Time columns are 110px each (AM/PM timestamps still render
              untruncated); the widthless Flags/Actions column absorbs the
              freed space so the overall table width is unchanged. */}
          <col className="w-[164px]" />
          <col className="w-[110px]" />
          <col className="w-[110px]" />
          <col className="w-[110px]" />
          <col className="w-[110px]" />
          <col />
          <col className="w-[100px]" />
          <col className="w-[100px]" />
          <col className="w-[100px]" />
          <col className="w-14" />
        </colgroup>
        <thead className="bg-slate-50 text-slate-700 font-semibold">
          <tr>
            <th className="py-2 pl-[10px] pr-1.5">Date</th>
            <th className="px-1.5 py-2">Clock In</th>
            <th className="px-1.5 py-2">Lunch Out</th>
            <th className="px-1.5 py-2">Lunch In</th>
            <th className="px-1.5 py-2">Clock Out</th>
            <th className="px-1.5 py-2">{bulkEdit ? 'Actions' : 'Flags'}</th>
            <th className="px-1.5 py-2">Regular</th>
            <th className="px-1.5 py-2">OT</th>
            <th className="px-1.5 py-2">DT</th>
            <th className="py-2 pl-1.5 pr-[10px] text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {dailyEntries.flatMap((day: DocumentData) => {
            const rowKey = String(day.id ?? day.workDate);
            const multi = isMultiShift(day);
            // Purely state-driven: bulk-edit entry pre-populates multi-shift
            // days; addShift expands single-shift days that become multi.
            const isExpanded = expanded.has(rowKey);
            const toggle = () =>
              setExpanded(prev => {
                const n = new Set(prev);
                if (n.has(rowKey)) n.delete(rowKey); else n.add(rowKey);
                return n;
              });

            const dayTotalMinutes = day.totalWorkMinutes || 0;
            const dayTotalHours = dayTotalMinutes / 60; // retained for the >8h red-tint threshold
            const draft = drafts.get(rowKey);
            const live = draft ? liveTotals.get(rowKey) : undefined;
            const changed = draft ? dayDraftChanged(draft) : false;

            // ---- READ MODE (unchanged rendering) --------------------------
            if (!bulkEdit) {
              const parentRow = (
                <tr key={rowKey} className="border-b border-slate-100 hover:bg-slate-50/50">
                  <td className="py-2 pl-[10px] pr-1.5 font-medium align-middle">
                    <span className={`inline-flex items-center gap-1 ${multi ? 'cursor-pointer' : ''}`} onClick={multi ? toggle : undefined}>
                      {multi && (isExpanded
                        ? <ChevronDown className="size-3.5 text-slate-500" />
                        : <ChevronRight className="size-3.5 text-slate-500" />)}
                      {formatDate(String(day.workDate))}
                      {multi && <span className="ml-1 text-xs font-normal text-slate-400">({segmentsOf(day).length} shifts)</span>}
                    </span>
                  </td>
                  <td className="px-1.5 py-2 align-middle">{renderParentBoundary(day, 'in')}</td>
                  <td className="px-1.5 py-2 align-middle">{renderParentLunch(day, 'out')}</td>
                  <td className="px-1.5 py-2 align-middle">{renderParentLunch(day, 'in')}</td>
                  <td className="px-1.5 py-2 align-middle">{renderParentBoundary(day, 'out')}</td>
                  <td className="px-1.5 py-2 align-middle">{renderParentFlags(day)}</td>
                  {/* Direct HH:MM strings produced by the OT engine on each
                      adjusted entry (fall back to formatting the raw minutes
                      for any entry that pre-dates the annotation). */}
                  <td className="px-1.5 py-2 align-middle">{day.regularTime ?? formatMinutesToHHMM(day.regularMinutes || 0)}</td>
                  <td className="px-1.5 py-2 align-middle">{day.otTime ?? formatMinutesToHHMM(day.otMinutes || 0)}</td>
                  <td className="px-1.5 py-2 align-middle">{day.doubleTimeTime ?? formatMinutesToHHMM(day.doubleTimeMinutes || 0)}</td>
                  <td className={`py-2 pl-1.5 pr-[10px] text-right align-middle font-semibold ${dayTotalHours > 8 ? 'text-red-600' : ''}`}>
                    {day.totalTime ?? formatMinutesToHHMM(dayTotalMinutes)}
                  </td>
                </tr>
              );
              const rows = [parentRow];
              if (multi && isExpanded) {
                segmentsOf(day).forEach((seg: DocumentData, i: number) => {
                  const shiftTotalMinutes = seg.workMinutes || 0;
                  const shiftTotalHours = shiftTotalMinutes / 60;
                  rows.push(
                    <tr key={`${rowKey}-seg-${i}`} className="bg-purple-50/40 hover:bg-purple-50/70 border-b border-purple-100">
                      <td className="py-2 pl-[10px] pr-1.5 text-purple-700 font-medium align-middle">↳ Shift {i + 1}</td>
                      <td className="px-1.5 py-2 align-middle">{renderSegBoundary(seg, 'clockInManual')}</td>
                      <td className="px-1.5 py-2 align-middle">
                        {seg.skipLunch ? <span className="italic text-slate-400">skipped</span> : renderSegBoundary(seg, 'lunchOutManual')}
                      </td>
                      <td className="px-1.5 py-2 align-middle">
                        {seg.skipLunch ? <span className="italic text-slate-400">skipped</span> : renderSegBoundary(seg, 'lunchInManual')}
                      </td>
                      <td className="px-1.5 py-2 align-middle">{renderSegBoundary(seg, 'clockOutManual')}</td>
                      <td className="px-1.5 py-2 align-middle">{renderSegFlags(day, i)}</td>
                      <td className="px-1.5 py-2 align-middle text-slate-400">--</td>
                      <td className="px-1.5 py-2 align-middle text-slate-400">--</td>
                      <td className="px-1.5 py-2 align-middle text-slate-400">--</td>
                      <td className={`py-2 pl-1.5 pr-[10px] text-right align-middle font-semibold ${shiftTotalHours > 8 ? 'text-red-600' : 'text-purple-700'}`}>
                        {formatMinutesToHHMM(shiftTotalMinutes)}
                      </td>
                    </tr>,
                  );
                });
              }
              return rows;
            }

            // ---- BULK EDIT MODE -------------------------------------------
            if (!draft) return [];
            const visibleSegs = draft.segments;
            const showChildren = multi || visibleSegs.length > 1;
            const dayTotalLive = live ? live.totalWorkMinutes / 60 : dayTotalHours;

            const parentRow = (
              <tr key={rowKey} className="border-b border-slate-100 bg-white">
                <td className="py-2 pl-[10px] pr-1.5 font-medium align-middle">
                  <span className={`inline-flex items-center gap-1 ${showChildren ? 'cursor-pointer' : ''}`} onClick={showChildren ? toggle : undefined}>
                    {showChildren && (isExpanded
                      ? <ChevronDown className="size-3.5 text-slate-500" />
                      : <ChevronRight className="size-3.5 text-slate-500" />)}
                    {formatDate(draft.workDate)}
                    {showChildren && <span className="ml-1 text-xs font-normal text-slate-400">({visibleSegs.length} shifts)</span>}
                  </span>
                </td>
                {/* Parent row shows the aggregate metric cells (live); time
                    cells stay editable only on child rows in multi-shift days.
                    For single-shift days the parent row IS the editable row. */}
                {showChildren ? (
                  <>
                    <td className="px-1.5 py-2 align-middle text-slate-400" colSpan={4}>— edit shifts below —</td>
                  </>
                ) : (
                  (() => {
                    const seg = visibleSegs[0];
                    if (!seg) return <td colSpan={4} />;
                    return (
                      <>
                        <td className="px-1.5 py-2 align-middle">
                          <input type="time" value={seg.clockInManual} disabled={seg.deleted}
                            onChange={e => updateCell(rowKey, seg.key, 'clockInManual', e.target.value)}
                            className={inputCls(rowKey, seg, 'clockInManual')} title={cellErr(rowKey, seg.key, 'clockInManual')} />
                        </td>
                        <td className="px-1.5 py-2 align-middle">
                          <input type="time" value={seg.lunchOutManual} disabled={seg.deleted || seg.skipLunch}
                            onChange={e => updateCell(rowKey, seg.key, 'lunchOutManual', e.target.value)}
                            className={inputCls(rowKey, seg, 'lunchOutManual')} title={cellErr(rowKey, seg.key, 'lunchOutManual')} />
                        </td>
                        <td className="px-1.5 py-2 align-middle">
                          <input type="time" value={seg.lunchInManual} disabled={seg.deleted || seg.skipLunch}
                            onChange={e => updateCell(rowKey, seg.key, 'lunchInManual', e.target.value)}
                            className={inputCls(rowKey, seg, 'lunchInManual')} title={cellErr(rowKey, seg.key, 'lunchInManual')} />
                        </td>
                        <td className="px-1.5 py-2 align-middle">
                          <input type="time" value={seg.clockOutManual} disabled={seg.deleted}
                            onChange={e => updateCell(rowKey, seg.key, 'clockOutManual', e.target.value)}
                            className={inputCls(rowKey, seg, 'clockOutManual')} title={cellErr(rowKey, seg.key, 'clockOutManual')} />
                        </td>
                      </>
                    );
                  })()
                )}
                {/* Actions column */}
                <td className="px-1.5 py-2 align-middle">
                  <div className="flex items-center gap-1">
                    {!showChildren && visibleSegs[0] && (
                      <>
                        <label className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                          <Checkbox
                            checked={visibleSegs[0].skipLunch}
                            onCheckedChange={c => toggleSkipLunch(rowKey, visibleSegs[0].key, c === true)}
                            disabled={visibleSegs[0].deleted}
                          />
                          skip lunch
                        </label>
                        <button
                          type="button"
                          title={visibleSegs[0].deleted ? 'Undo delete' : 'Delete shift'}
                          onClick={() => deleteShift(rowKey, visibleSegs[0].key)}
                          className={`p-1 rounded hover:bg-red-50 ${visibleSegs[0].deleted ? 'text-red-600' : 'text-slate-400 hover:text-red-600'}`}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      title="Add shift"
                      onClick={() => addShift(rowKey)}
                      className="inline-flex items-center gap-0.5 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 hover:bg-indigo-100"
                    >
                      <Plus className="size-3" /> Add Shift
                    </button>
                  </div>
                </td>
                <td className={metricCls(changed)}>{live ? formatMinutesToHHMM(live.regularMinutes) : (day.regularTime ?? formatMinutesToHHMM(day.regularMinutes || 0))}</td>
                <td className={metricCls(changed)}>{live ? formatMinutesToHHMM(live.otMinutes) : (day.otTime ?? formatMinutesToHHMM(day.otMinutes || 0))}</td>
                <td className={metricCls(changed)}>{live ? formatMinutesToHHMM(live.doubleTimeMinutes) : (day.doubleTimeTime ?? formatMinutesToHHMM(day.doubleTimeMinutes || 0))}</td>
                <td className={`py-2 pl-1.5 pr-[10px] text-right align-middle font-semibold ${dayTotalLive > 8 ? 'text-red-600' : ''} ${changed ? 'bg-amber-100/70' : ''}`}>
                  {live ? formatMinutesToHHMM(live.totalWorkMinutes) : (day.totalTime ?? formatMinutesToHHMM(dayTotalMinutes))}
                </td>
              </tr>
            );

            const rows = [parentRow];
            if (showChildren && isExpanded) {
              visibleSegs.forEach((seg, i) => {
                const segDeleted = seg.deleted;
                rows.push(
                  <tr key={`${rowKey}-edit-${seg.key}`} className={`border-b ${segDeleted ? 'bg-red-50/50 opacity-60' : 'bg-purple-50/40'}`}>
                    <td className="py-2 pl-[10px] pr-1.5 text-purple-700 font-medium align-middle">
                      ↳ Shift {i + 1}{seg.isNew ? ' (new)' : ''}{segDeleted ? ' (deleted)' : ''}
                    </td>
                    <td className="px-1.5 py-2 align-middle">
                      <input type="time" value={seg.clockInManual} disabled={segDeleted}
                        onChange={e => updateCell(rowKey, seg.key, 'clockInManual', e.target.value)}
                        className={inputCls(rowKey, seg, 'clockInManual')} title={cellErr(rowKey, seg.key, 'clockInManual')} />
                    </td>
                    <td className="px-1.5 py-2 align-middle">
                      <input type="time" value={seg.lunchOutManual} disabled={segDeleted || seg.skipLunch}
                        onChange={e => updateCell(rowKey, seg.key, 'lunchOutManual', e.target.value)}
                        className={inputCls(rowKey, seg, 'lunchOutManual')} title={cellErr(rowKey, seg.key, 'lunchOutManual')} />
                    </td>
                    <td className="px-1.5 py-2 align-middle">
                      <input type="time" value={seg.lunchInManual} disabled={segDeleted || seg.skipLunch}
                        onChange={e => updateCell(rowKey, seg.key, 'lunchInManual', e.target.value)}
                        className={inputCls(rowKey, seg, 'lunchInManual')} title={cellErr(rowKey, seg.key, 'lunchInManual')} />
                    </td>
                    <td className="px-1.5 py-2 align-middle">
                      <input type="time" value={seg.clockOutManual} disabled={segDeleted}
                        onChange={e => updateCell(rowKey, seg.key, 'clockOutManual', e.target.value)}
                        className={inputCls(rowKey, seg, 'clockOutManual')} title={cellErr(rowKey, seg.key, 'clockOutManual')} />
                    </td>
                    <td className="px-1.5 py-2 align-middle">
                      <div className="flex items-center gap-1">
                        <label className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                          <Checkbox
                            checked={seg.skipLunch}
                            onCheckedChange={c => toggleSkipLunch(rowKey, seg.key, c === true)}
                            disabled={segDeleted}
                          />
                          skip lunch
                        </label>
                        <button
                          type="button"
                          title={segDeleted ? 'Undo delete' : 'Delete shift'}
                          onClick={() => deleteShift(rowKey, seg.key)}
                          className={`p-1 rounded hover:bg-red-50 ${segDeleted ? 'text-red-600' : 'text-slate-400 hover:text-red-600'}`}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-1.5 py-2 align-middle text-slate-400">--</td>
                    <td className="px-1.5 py-2 align-middle text-slate-400">--</td>
                    <td className="px-1.5 py-2 align-middle text-slate-400">--</td>
                    <td className="py-2 pl-1.5 pr-[10px] text-right align-middle font-semibold text-purple-700">
                      {segDeleted
                        ? '--'
                        : ((() => {
                          const wm = computeSegmentWorkMinutes({
                            clockInManual: seg.clockInManual,
                            clockOutManual: seg.clockOutManual,
                            lunchOutManual: seg.skipLunch ? undefined : seg.lunchOutManual,
                            lunchInManual: seg.skipLunch ? undefined : seg.lunchInManual,
                            skipLunch: seg.skipLunch,
                            complete: !!seg.clockOutManual,
                          } as TimeSegment);
                          return formatMinutesToHHMM(wm);
                        })())}
                    </td>
                  </tr>,
                );
              });
            }
            return rows;
          })}
        </tbody>
      </table>

      {/* No bottom preview strip: live totals surface directly on the
          employee summary card above (via onLiveTotals) instead. */}
    </div>
  );
}
