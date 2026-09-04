/**
 * Regression test: Edit / Request Time Adjustments row ordering.
 *
 * The pre-fix cross-midnight doc (23:32→00:28 on 07/29) explodes into rows
 * for 07/29 and 07/30. The table everywhere else is newest-first, so the
 * 07/30 row must appear ABOVE the 07/29 row — before the fix, the explosion
 * emitted them ascending (07/29 on top), which looked inconsistent.
 */
jest.mock('../../lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));

import { flattenToShiftRows } from './shiftRows';
import type { TimeEntry } from '../../lib/database';

function corruptedCrossMidnightDoc(): TimeEntry {
  return {
    id: 'u1_2026-07-29',
    userId: 'u1',
    date: '2026-07-29',
    workDate: '2026-07-29',
    complete: true,
    status: 'active',
    totalWorkMinutes: 56,
    clockInManual: '23:32',
    clockOutManual: '00:28',
    currentSegment: { id: 'u1_2026-07-29_current', clockInManual: '23:32', clockOutManual: '00:28', complete: true, workMinutes: 56 },
    segments: [
      { id: 'seg_d1', clockInManual: '23:32', clockOutManual: '23:59', workMinutes: 28, complete: true, splitFromMidnight: true, localDate: '2026-07-29' },
      { id: 'seg_d2', clockInManual: '00:00', clockOutManual: '00:28', workMinutes: 28, complete: true, splitFromMidnight: true, localDate: '2026-07-30' },
    ],
  } as TimeEntry;
}

function normalDoc(date: string): TimeEntry {
  return {
    id: `u1_${date}`,
    userId: 'u1',
    date,
    workDate: date,
    complete: true,
    status: 'active',
    totalWorkMinutes: 480,
    segments: [{ id: `s_${date}`, clockInManual: '09:00', clockOutManual: '17:00', workMinutes: 480, complete: true }],
  } as TimeEntry;
}

describe('flattenToShiftRows — row ordering (newest date first)', () => {
  it('places the exploded 07/30 row above the 07/29 row (2 rows total)', () => {
    const rows = flattenToShiftRows([corruptedCrossMidnightDoc()]);
    expect(rows).toHaveLength(2);
    expect(rows[0].entry.date).toBe('2026-07-30');
    expect(rows[0].segment.clockInManual).toBe('00:00');
    expect(rows[0].segment.clockOutManual).toBe('00:28');
    expect(rows[1].entry.date).toBe('2026-07-29');
    expect(rows[1].segment.clockInManual).toBe('23:32');
    expect(rows[1].segment.clockOutManual).toBe('23:59');
  });

  it('keeps overall newest-first order across multiple docs', () => {
    // Firestore returns workDate desc: [07/29 (corrupted), 07/28].
    const rows = flattenToShiftRows([corruptedCrossMidnightDoc(), normalDoc('2026-07-28')]);
    expect(rows.map((r) => r.entry.date)).toEqual(['2026-07-30', '2026-07-29', '2026-07-28']);
  });

  it('keeps chronological shift order within the same date (stable sort)', () => {
    const splitDay: TimeEntry = {
      id: 'u1_2026-07-28',
      userId: 'u1',
      date: '2026-07-28',
      workDate: '2026-07-28',
      complete: true,
      status: 'active',
      segments: [
        { id: 's1', clockInManual: '08:00', clockOutManual: '12:00', workMinutes: 240, complete: true },
        { id: 's2', clockInManual: '13:00', clockOutManual: '17:00', workMinutes: 240, complete: true },
      ],
    } as TimeEntry;
    const rows = flattenToShiftRows([splitDay]);
    expect(rows).toHaveLength(2);
    expect(rows[0].segment.clockInManual).toBe('08:00');
    expect(rows[1].segment.clockInManual).toBe('13:00');
  });
});
