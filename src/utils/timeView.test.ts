import { explodeDocBySegmentLocalDate, explodeDocsBySegmentLocalDate, writeDocId, calendarDayOffsetInZone, PT_ZONE, type ExplodableDoc } from './timeView';

describe('explodeDocBySegmentLocalDate', () => {
  it('splits a pre-fix cross-midnight doc into one doc per local date (23:32→00:28 bug)', () => {
    const doc = {
      id: 'u1_2026-07-29',
      userId: 'u1',
      date: '2026-07-29',
      workDate: '2026-07-29',
      complete: true,
      totalWorkMinutes: 56,
      // Top-level fields spanning midnight (the corrupted shape):
      clockInManual: '23:32',
      clockOutManual: '00:28',
      currentSegment: { clockInManual: '23:32', clockOutManual: '00:28', complete: true, workMinutes: 56 },
      segments: [
        {
          id: 'seg_d1',
          clockInManual: '23:32',
          clockOutManual: '23:59',
          complete: true,
          workMinutes: 28,
          splitFromMidnight: true,
          localDate: '2026-07-29',
        },
        {
          id: 'seg_d2',
          clockInManual: '00:00',
          clockOutManual: '00:28',
          complete: true,
          workMinutes: 28,
          splitFromMidnight: true,
          localDate: '2026-07-30',
        },
      ],
    };

    const out = explodeDocBySegmentLocalDate(doc);
    expect(out).toHaveLength(2);

    // Day 1: yesterday, its own portion only, synthesized current dropped.
    expect(out[0].workDate).toBe('2026-07-29');
    expect(out[0].id).toBe('u1_2026-07-29@2026-07-29'); // synthetic, non-colliding
    expect(out[0].segments).toHaveLength(1);
    expect(out[0].segments?.[0].clockInManual).toBe('23:32');
    expect(out[0].clockOutManual).toBe('23:59');
    expect(out[0].totalWorkMinutes).toBe(28);
    expect(out[0].currentSegment).toBeUndefined();
    expect(out[0].complete).toBe(true);

    // Day 2: today, attributed to 07/30.
    expect(out[1].workDate).toBe('2026-07-30');
    expect(out[1].id).toBe('u1_2026-07-29@2026-07-30'); // synthetic, non-colliding
    expect(out[1].segments).toHaveLength(1);
    expect(out[1].segments?.[0].clockInManual).toBe('00:00');
    expect(out[1].clockOutManual).toBe('00:28');
    expect(out[1].totalWorkMinutes).toBe(28);
  });

  it('returns normal single-day docs unchanged (no localDate on segments)', () => {
    const doc = {
      id: 'u1_2026-07-29',
      userId: 'u1',
      date: '2026-07-29',
      segments: [{ id: 's1', clockInManual: '09:00', clockOutManual: '17:00', complete: true, workMinutes: 480 }],
    };
    const out = explodeDocBySegmentLocalDate(doc);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(doc);
  });

  it('returns same-day split-shift docs unchanged (all segments share the doc date)', () => {
    const doc = {
      id: 'u1_2026-07-29',
      userId: 'u1',
      date: '2026-07-29',
      segments: [
        { id: 's1', clockInManual: '08:00', clockOutManual: '12:00', complete: true, workMinutes: 240 },
        { id: 's2', clockInManual: '13:00', clockOutManual: '17:00', complete: true, workMinutes: 240 },
      ],
    };
    expect(explodeDocBySegmentLocalDate(doc)).toHaveLength(1);
  });

  it('returns segment-less docs unchanged', () => {
    const doc = { id: 'u1_2026-07-29', userId: 'u1', date: '2026-07-29', clockInManual: '09:00' };
    expect(explodeDocBySegmentLocalDate(doc)).toHaveLength(1);
  });

  it('explodeDocsBySegmentLocalDate flatMaps a list', () => {
    const docs: ExplodableDoc[] = [
      {
        id: 'u1_2026-07-29', userId: 'u1', date: '2026-07-29',
        segments: [
          { id: 'a', clockInManual: '23:32', clockOutManual: '23:59', complete: true, workMinutes: 28, localDate: '2026-07-29' },
          { id: 'b', clockInManual: '00:00', clockOutManual: '00:28', complete: true, workMinutes: 28, localDate: '2026-07-30' },
        ],
      },
      {
        id: 'u1_2026-07-28', userId: 'u1', date: '2026-07-28',
        segments: [{ id: 'c', clockInManual: '09:00', clockOutManual: '17:00', complete: true, workMinutes: 480 }],
      },
    ];
    const out = explodeDocsBySegmentLocalDate(docs);
    expect(out).toHaveLength(3);
    expect(out.map((d) => d.workDate ?? d.date)).toEqual(['2026-07-29', '2026-07-30', '2026-07-28']);
  });
});

describe('exploded entry — synthetic/source markers + per-part fields', () => {
  function crossMidnightDoc(): ExplodableDoc {
    return {
      id: 'u1_2026-07-29',
      userId: 'u1',
      date: '2026-07-29',
      workDate: '2026-07-29',
      complete: true,
      // Doc-level lunch fields spanning the shift (should NOT leak into parts).
      lunchOutManual: '21:00',
      lunchInManual: '21:30',
      skipLunch: false,
      segments: [
        {
          id: 'd1', clockInManual: '20:00', clockOutManual: '23:59',
          lunchOutManual: '21:00', lunchInManual: '21:30',
          complete: true, workMinutes: 209, splitFromMidnight: true, localDate: '2026-07-29',
        },
        {
          id: 'd2', clockInManual: '00:00', clockOutManual: '04:00',
          complete: true, workMinutes: 240, splitFromMidnight: true, localDate: '2026-07-30',
        },
      ],
    };
  }

  it('marks exploded entries synthetic and records sourceId = source doc id', () => {
    const out = explodeDocBySegmentLocalDate(crossMidnightDoc());
    expect(out).toHaveLength(2);
    for (const part of out) {
      expect(part.synthetic).toBe(true);
      expect(part.sourceId).toBe('u1_2026-07-29');
    }
  });

  it('derives per-part lunch fields from the part segments, not the doc top-level', () => {
    const out = explodeDocBySegmentLocalDate(crossMidnightDoc());
    const [day1, day2] = out;
    // Day 1 had the lunch (21:00–21:30); Day 2 had none.
    expect(day1.lunchOutManual).toBe('21:00');
    expect(day1.lunchInManual).toBe('21:30');
    expect(day1.skipLunch).toBe(false);
    expect(day2.lunchOutManual).toBeUndefined();
    expect(day2.lunchInManual).toBeUndefined();
  });

  it('writeDocId returns sourceId for synthetic parts and id for real docs', () => {
    const out = explodeDocBySegmentLocalDate(crossMidnightDoc());
    const [day1, day2] = out;
    // Both synthetic parts write against the persisted 07/29 doc.
    expect(writeDocId(day1)).toBe('u1_2026-07-29');
    expect(writeDocId(day2)).toBe('u1_2026-07-29');
    // A real (non-exploded) doc writes against its own id.
    const real: ExplodableDoc = { id: 'u1_2026-07-28', userId: 'u1', date: '2026-07-28' };
    expect(writeDocId(real)).toBe('u1_2026-07-28');
  });

  it('synthetic ids are distinct from the source id and marked synthetic (resolution via sourceId, not id-equality)', () => {
    const out = explodeDocBySegmentLocalDate(crossMidnightDoc());
    const [day1] = out;
    // The synthetic id embeds the source id + date with a '@' separator, so it
    // NEVER equals the persisted `${uid}_${date}` source id.
    expect(day1.id).toBe('u1_2026-07-29@2026-07-29');
    expect(day1.id).not.toBe(day1.sourceId);
    expect(day1.synthetic).toBe(true);
    expect(day1.sourceId).toBe('u1_2026-07-29');
    expect(writeDocId(day1)).toBe('u1_2026-07-29');
  });

  it('REGRESSION: synthetic part id never collides with a real same-date doc id (bot review)', () => {
    // Scenario: user has a cross-midnight shift 07/29→07/30 (pre-fix doc) AND a
    // normal real shift on 07/30 (its own `${uid}_2026-07-30` doc). The exploded
    // 07/30 part must NOT reuse the real doc's id, or React keys/dedup collide.
    const crossMidnight: ExplodableDoc = {
      id: 'u1_2026-07-29', userId: 'u1', date: '2026-07-29', workDate: '2026-07-29', complete: true,
      segments: [
        { id: 'd1', clockInManual: '23:32', clockOutManual: '23:59', complete: true, workMinutes: 28, localDate: '2026-07-29', splitFromMidnight: true },
        { id: 'd2', clockInManual: '00:00', clockOutManual: '00:28', complete: true, workMinutes: 28, localDate: '2026-07-30', splitFromMidnight: true },
      ],
    };
    const realDay30: ExplodableDoc = {
      id: 'u1_2026-07-30', userId: 'u1', date: '2026-07-30', workDate: '2026-07-30', complete: true,
      segments: [{ id: 'r', clockInManual: '09:00', clockOutManual: '17:00', complete: true, workMinutes: 480 }],
    };
    const out = explodeDocsBySegmentLocalDate([crossMidnight, realDay30]);
    // 07/29 part, 07/30 part (synthetic), real 07/30 doc.
    expect(out).toHaveLength(3);
    const ids = out.map((d) => d.id);
    // All ids unique — no duplicates.
    expect(new Set(ids).size).toBe(3);
    // The synthetic 07/30 part does NOT equal the real 07/30 doc id.
    const syntheticPart = out.find((d) => d.synthetic && d.workDate === '2026-07-30');
    const realDoc = out.find((d) => !d.synthetic && d.id === 'u1_2026-07-30');
    expect(syntheticPart).toBeDefined();
    expect(realDoc).toBeDefined();
    expect(syntheticPart!.id).not.toBe('u1_2026-07-30');
    expect(syntheticPart!.id).toBe('u1_2026-07-29@2026-07-30');
    expect(realDoc!.id).toBe('u1_2026-07-30');
    // Both still attribute workDate correctly (day-attribution preserved).
    expect(syntheticPart!.workDate).toBe('2026-07-30');
  });
});

describe('calendarDayOffsetInZone (+Nd badge math)', () => {
  it('returns 0 for a same-day shift in the same zone (PT)', () => {
    // 2026-08-24 08:00 PDT → 17:00 PDT
    const inMs = Date.UTC(2026, 7, 24, 15, 0, 0);
    const outMs = Date.UTC(2026, 7, 25, 0, 0, 0); // 17:00 PDT same day
    expect(calendarDayOffsetInZone(inMs, outMs, PT_ZONE)).toBe(0);
  });

  it('returns 1 for a genuine cross-midnight shift (PT 23:32 → 00:28)', () => {
    // 2026-07-29 23:32 PDT → 2026-07-30 00:28 PDT
    const inMs = Date.UTC(2026, 7, 30, 6, 32, 0);
    const outMs = Date.UTC(2026, 7, 30, 7, 28, 0);
    expect(calendarDayOffsetInZone(inMs, outMs, PT_ZONE)).toBe(1);
  });

  it('returns 2 for a shift spanning two midnights', () => {
    const inMs = Date.UTC(2026, 7, 24, 15, 0, 0); // 08-24 08:00 PDT
    const outMs = Date.UTC(2026, 7, 26, 22, 0, 0); // 08-26 15:00 PDT
    expect(calendarDayOffsetInZone(inMs, outMs, PT_ZONE)).toBe(2);
  });

  it('REGRESSION: same-LOCAL-day shift (00:00→23:59 Riyadh) is 0 in the display zone, not 1 (false +1d badge)', () => {
    // Employee in Asia/Riyadh (UTC+3): 2026-08-24 00:00 → 23:59 local.
    const inMs = Date.UTC(2026, 7, 23, 21, 0, 0); // = 2026-08-24 00:00 +03:00
    const outMs = Date.UTC(2026, 7, 24, 20, 59, 0); // = 2026-08-24 23:59 +03:00
    // In the employee's display zone both instants share one calendar date.
    expect(calendarDayOffsetInZone(inMs, outMs, 'Asia/Riyadh')).toBe(0);
    // The old bug: the badge compared PT dates (08-23 14:00 → 08-24 13:59
    // PDT), yielding +1d next to an 11:59 PM same-day clock-out.
    expect(calendarDayOffsetInZone(inMs, outMs, PT_ZONE)).toBe(1);
  });

  it('REGRESSION: exploded day-2 slice (00:00→23:59:59 local, Riyadh) gets no +1d badge', () => {
    // midnightSplit day-1 boundary: local 23:59:59 = epoch midnight − 1s.
    const inMs = Date.UTC(2026, 7, 23, 21, 0, 0); // 2026-08-24 00:00:00 +03:00
    const outMs = Date.UTC(2026, 7, 24, 20, 59, 59); // 2026-08-24 23:59:59 +03:00
    expect(calendarDayOffsetInZone(inMs, outMs, 'Asia/Riyadh')).toBe(0);
  });

  it('still badges a genuinely late local clock-out (Riyadh 22:00 → 01:00 next day)', () => {
    const inMs = Date.UTC(2026, 7, 24, 19, 0, 0); // 2026-08-24 22:00 +03:00
    const outMs = Date.UTC(2026, 7, 24, 22, 0, 0); // 2026-08-25 01:00 +03:00
    expect(calendarDayOffsetInZone(inMs, outMs, 'Asia/Riyadh')).toBe(1);
  });
});
