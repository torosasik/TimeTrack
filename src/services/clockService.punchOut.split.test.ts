/**
 * Regression test: cross-midnight punchOut distributes split parts to
 * per-local-date docs.
 *
 * Scenario (reported bug): employee clocks in 23:32 on day N (local) and
 * clocks out 00:28 on day N+1. The local-midnight split must write:
 *   - day-N doc:   23:32→23:59 (closed), top-level fields mirroring THAT part
 *   - day-N+1 doc: 00:00→00:28 (closed), as its own workDate document
 * Pre-fix, both parts were stored on the day-N doc while top-level fields
 * still spanned 23:32→00:28 — causing a phantom third shift in the edit
 * modal, double-counted totals, and payroll aggregating everything under
 * day N.
 *
 * firebase/firestore and dbService are mocked; the real segmentOps /
 * midnightSplit logic runs.
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

const txGet = jest.fn();
const txUpdate = jest.fn();
const txSet = jest.fn();
const mockNowMs = Date.now();

jest.mock('firebase/firestore', () => ({
  doc: (_db: unknown, _col: string, id: string) => ({ id }),
  runTransaction: async (_db: unknown, cb: (tx: unknown) => unknown) =>
    cb({ get: txGet, update: txUpdate, set: txSet }),
  Timestamp: {
    now: () => ({ toMillis: () => mockNowMs }),
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
  },
  updateDoc: jest.fn(),
}));

import { punchOut } from './clockService';
import { getLocalDate, subtractLocalDays } from '../utils/timeCalculations';

const UID = 'splitTestUID';
const today = getLocalDate('UTC');
const yesterday = subtractLocalDays(today, 1, 'UTC');
const [ty, tm, td] = today.split('-').map(Number);
const clockInMs = Date.UTC(ty, tm - 1, td - 1, 23, 32, 0);

function openDoc(date: string, seg: Record<string, unknown>) {
  return {
    workDate: date,
    status: 'active',
    segments: [seg],
    clockInManual: seg.clockInManual,
    complete: false,
    totalWorkMinutes: 0,
  };
}

describe('punchOut — cross-midnight local split distributes to per-date docs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const openSeg = {
      id: 'seg_open',
      clockInManual: '23:32',
      clockInSystem: clockInMs,
      complete: false,
    };
    // findOpenShiftEntry: no doc today; range query returns yesterday's open entry.
    getTimeEntry.mockImplementation((_uid: string, date: string) => {
      if (date === today) return Promise.resolve(null);
      if (date === yesterday) return Promise.resolve({ id: `${UID}_${yesterday}` }); // final re-read
      return Promise.resolve(null);
    });
    getTimeEntriesForUserInRange.mockResolvedValue([
      {
        id: `${UID}_${yesterday}`,
        userId: UID,
        date: yesterday,
        complete: false,
        status: 'active',
        segments: [openSeg],
        clockInManual: '23:32',
      },
    ]);
    txGet.mockImplementation((ref: { id: string }) => {
      if (ref.id === `${UID}_${yesterday}`) {
        return Promise.resolve({ exists: () => true, data: () => openDoc(yesterday, openSeg), id: ref.id });
      }
      return Promise.resolve({ exists: () => false, data: () => undefined, id: ref.id });
    });
  });

  it('writes day-1 part to the punch-in doc and day-2 part to its own today doc', async () => {
    await punchOut(UID, 'UTC');

    // Original doc (yesterday): closed Day-1 portion only, top-level mirrors it.
    expect(txUpdate).toHaveBeenCalledTimes(1);
    const [updRef, updPayload] = txUpdate.mock.calls[0] as [{ id: string }, Record<string, any>];
    expect(updRef.id).toBe(`${UID}_${yesterday}`);
    expect(updPayload.clockOutManual).toBe('23:59');
    expect(updPayload.complete).toBe(true);
    expect(updPayload.dayComplete).toBe(true);
    expect(updPayload.segments).toHaveLength(1);
    expect(updPayload.segments[0].clockInManual).toBe('23:32');
    expect(updPayload.segments[0].clockOutManual).toBe('23:59');
    expect(updPayload.segments[0].complete).toBe(true);
    expect(updPayload.segments[0].localDate).toBe(yesterday);
    expect(updPayload.totalWorkMinutes).toBe(updPayload.segments[0].workMinutes);

    // Day-2 doc (today): created with its own closed portion.
    expect(txSet).toHaveBeenCalledTimes(1);
    const [setRef, setPayload] = txSet.mock.calls[0] as [{ id: string }, Record<string, any>];
    expect(setRef.id).toBe(`${UID}_${today}`);
    expect(setPayload.workDate).toBe(today);
    expect(setPayload.clockInManual).toBe('00:00');
    expect(setPayload.complete).toBe(true);
    expect(setPayload.segments).toHaveLength(1);
    expect(setPayload.segments[0].clockInManual).toBe('00:00');
    expect(setPayload.segments[0].complete).toBe(true);
    expect(setPayload.segments[0].localDate).toBe(today);
    expect(setPayload.totalWorkMinutes).toBe(setPayload.segments[0].workMinutes);
  });
});

describe('punchOut — single-day close stays on one doc (regression)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const openSeg = {
      id: 'seg_today',
      clockInManual: '08:00',
      clockInSystem: Date.UTC(ty, tm - 1, td, 8, 0, 0),
      complete: false,
    };
    const entry = {
      id: `${UID}_${today}`,
      userId: UID,
      date: today,
      complete: false,
      status: 'active',
      segments: [openSeg],
      clockInManual: '08:00',
    };
    getTimeEntry.mockImplementation((_uid: string, date: string) => {
      if (date === today) return Promise.resolve(entry);
      return Promise.resolve(null);
    });
    getTimeEntriesForUserInRange.mockResolvedValue([]);
    txGet.mockImplementation((ref: { id: string }) => {
      if (ref.id === `${UID}_${today}`) {
        return Promise.resolve({ exists: () => true, data: () => openDoc(today, openSeg), id: ref.id });
      }
      return Promise.resolve({ exists: () => false, data: () => undefined, id: ref.id });
    });
  });

  it('closes in place with tx.update only (no extra docs)', async () => {
    await punchOut(UID, 'UTC');
    expect(txUpdate).toHaveBeenCalledTimes(1);
    const [updRef, updPayload] = txUpdate.mock.calls[0] as [{ id: string }, Record<string, any>];
    expect(updRef.id).toBe(`${UID}_${today}`);
    expect(updPayload.complete).toBe(true);
    expect(updPayload.segments).toHaveLength(1);
    expect(txSet).not.toHaveBeenCalled();
  });
});
