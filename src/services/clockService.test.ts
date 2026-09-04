/**
 * S5 regression tests for findOpenShiftEntry.
 *
 * Covers the cross-midnight scenario: an employee clocks in at 23:00 PT on
 * day N, and after midnight PT (day N+1) the open segment still lives on the
 * day-N doc. findOpenShiftEntry must locate it by scanning recent days so
 * punchOut / getPunchStatus / toggleLunch keep working across midnight.
 *
 * dbService is mocked (firebase-free); getActiveSegment uses the real pure
 * implementation from segmentOps.
 */
jest.mock('../app/lib/firebase', () => ({ db: {} }));

const getTimeEntry = jest.fn();
const getTimeEntriesForUserInRange = jest.fn();

jest.mock('../app/lib/database', () => {
  const actual = jest.requireActual('../app/lib/database');
  return {
    ...actual,
    dbService: {
      getTimeEntry,
      getTimeEntriesForUserInRange,
    },
  };
});

import { findOpenShiftEntry, getWeekSummary } from './clockService';
import { getCurrentPTDate, getPTDate } from '../utils/timeCalculations';
import type { TimeEntry } from '../app/lib/database';

/** Subtract N days from a PT YYYY-MM-DD string, returning PT YYYY-MM-DD
 * (mirrors clockService.subtractPTDays via a PT-noon UTC anchor). */
function subtractPTDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return getPTDate(new Date(Date.UTC(y, m - 1, d - days, 12, 0, 0)));
}

function makeEntry(userId: string, date: string, open: boolean): TimeEntry {
  return {
    id: `${userId}_${date}`,
    userId,
    date,
    clockInManual: open ? '23:00' : '08:00',
    clockOutManual: open ? undefined : '17:00',
    complete: !open,
    currentStep: open ? 2 : 4,
    status: 'active',
    segments: [
      {
        id: `seg_${date}`,
        clockInManual: open ? '23:00' : '08:00',
        clockOutManual: open ? undefined : '17:00',
        complete: !open,
      } as any,
    ],
  } as any;
}

const UID = 'bTSuNL1pNZVtAS724rwlMGW4qJm1';

describe('findOpenShiftEntry — S5 cross-midnight', () => {
  beforeEach(() => {
    getTimeEntry.mockReset();
    getTimeEntriesForUserInRange.mockReset();
  });

  it('fast-path returns today’s entry when it has an open segment', async () => {
    const today = '2026-07-17';
    const open = makeEntry(UID, today, true);
    getTimeEntry.mockResolvedValue(open);

    const result = await findOpenShiftEntry(UID);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(open.id);
    expect(getTimeEntry).toHaveBeenCalledTimes(1);
    // Fallback query must NOT run when today’s doc already has the open shift.
    expect(getTimeEntriesForUserInRange).not.toHaveBeenCalled();
  });

  it('falls back to a prior-day doc when today has no open segment (cross-midnight)', async () => {
    // Derive dates from the real current PT date so the test is date-stable
    // (findOpenShiftEntry calls the real getCurrentPTDate()).
    const today = getCurrentPTDate();
    const yesterday = subtractPTDays(today, 1);
    const threeDaysAgo = subtractPTDays(today, 3);
    const twoDaysAgo = subtractPTDays(today, 2);
    // Today’s doc: complete, no open segment.
    getTimeEntry.mockResolvedValue(makeEntry(UID, today, false));
    // Range query returns yesterday’s open shift first (workDate desc).
    getTimeEntriesForUserInRange.mockResolvedValue([
      makeEntry(UID, yesterday, true), // open cross-midnight shift
      makeEntry(UID, twoDaysAgo, false),
    ]);

    const result = await findOpenShiftEntry(UID);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(`${UID}_${yesterday}`);
    expect(result?.date).toBe(yesterday);
    // Range query covers the last 3 PT days ending today.
    const [uid, start, end] = getTimeEntriesForUserInRange.mock.calls[0];
    expect(uid).toBe(UID);
    expect(end).toBe(today);
    expect(start).toBe(threeDaysAgo); // today - 3 days
  });

  it('returns null when no open shift exists on any recent day', async () => {
    const today = getCurrentPTDate();
    getTimeEntry.mockResolvedValue(makeEntry(UID, today, false));
    getTimeEntriesForUserInRange.mockResolvedValue([
      makeEntry(UID, subtractPTDays(today, 1), false),
      makeEntry(UID, subtractPTDays(today, 2), false),
    ]);

    const result = await findOpenShiftEntry(UID);
    expect(result).toBeNull();
  });

  it('skips voided/archived docs when scanning for an open shift', async () => {
    // Today: none. Range returns a voided doc with a nominally-open segment,
    // which getActiveSegment must ignore, plus a real open shift.
    const today = getCurrentPTDate();
    getTimeEntry.mockResolvedValue(null);
    const voided = makeEntry(UID, subtractPTDays(today, 1), true);
    voided.status = 'voided';
    const active = makeEntry(UID, subtractPTDays(today, 2), true);
    getTimeEntriesForUserInRange.mockResolvedValue([voided, active]);

    const result = await findOpenShiftEntry(UID);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(active.id);
  });
});

describe('getWeekSummary — cross-midnight split attribution (This Week card)', () => {
  beforeEach(() => {
    getTimeEntry.mockReset();
    getTimeEntriesForUserInRange.mockReset();
  });

  it('counts 2 days worked for a pre-fix 23:32→00:28 split stored on one doc', async () => {
    // The corrupted shape that exposed the bug: both midnight-split parts on
    // the 07/29 doc, day-2 part attributed to localDate 07/30.
    const corrupted = {
      id: `${UID}_2026-07-29`,
      userId: UID,
      date: '2026-07-29',
      workDate: '2026-07-29',
      complete: true,
      status: 'active',
      totalWorkMinutes: 56,
      clockInManual: '23:32',
      clockOutManual: '00:28',
      currentSegment: { clockInManual: '23:32', clockOutManual: '00:28', complete: true, workMinutes: 56 },
      segments: [
        { id: 'seg_d1', clockInManual: '23:32', clockOutManual: '23:59', workMinutes: 28, complete: true, splitFromMidnight: true, localDate: '2026-07-29' },
        { id: 'seg_d2', clockInManual: '00:00', clockOutManual: '00:28', workMinutes: 28, complete: true, splitFromMidnight: true, localDate: '2026-07-30' },
      ],
    } as any;
    getTimeEntriesForUserInRange.mockResolvedValue([corrupted]);

    const summary = await getWeekSummary(UID, 'UTC');
    expect(summary.daysWorked).toBe(2);
    expect(summary.totalMinutes).toBe(56);
  });

  it('counts distinct dates (not docs) and skips voided docs', async () => {
    const d1 = {
      id: `${UID}_2026-07-28`, userId: UID, date: '2026-07-28', workDate: '2026-07-28',
      complete: true, status: 'active', totalWorkMinutes: 480,
      segments: [{ id: 'a', clockInManual: '09:00', clockOutManual: '17:00', workMinutes: 480, complete: true }],
    } as any;
    const voided = { ...d1, id: `${UID}_2026-07-27`, date: '2026-07-27', workDate: '2026-07-27', status: 'voided' } as any;
    getTimeEntriesForUserInRange.mockResolvedValue([d1, voided]);

    const summary = await getWeekSummary(UID, 'UTC');
    expect(summary.daysWorked).toBe(1);
    expect(summary.totalMinutes).toBe(480);
  });

  it('normal same-date multi-doc day counts once', async () => {
    // Two docs sharing a date (pathological duplicate) must count one day.
    const mk = (id: string) => ({
      id, userId: UID, date: '2026-07-28', workDate: '2026-07-28',
      complete: true, status: 'active', totalWorkMinutes: 120,
      segments: [{ id: `s_${id}`, clockInManual: '09:00', clockOutManual: '11:00', workMinutes: 120, complete: true }],
    }) as any;
    getTimeEntriesForUserInRange.mockResolvedValue([mk(`${UID}_2026-07-28`), mk(`${UID}_2026-07-28_dup`)]);

    const summary = await getWeekSummary(UID, 'UTC');
    expect(summary.daysWorked).toBe(1);
    expect(summary.totalMinutes).toBe(240);
  });
});
