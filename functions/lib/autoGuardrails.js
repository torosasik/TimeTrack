"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAutoGuardrails = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const moment_timezone_1 = __importDefault(require("moment-timezone"));
// Initialize admin if not already initialized in index.ts
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();
const DEFAULT_TIMEZONE = 'America/Los_Angeles';
const DEFAULT_LIMITS = {
    onsiteLatestAllowedTime: '22:00',
    onsiteRecordedTime: '17:00',
    onsiteLunchMaxMinutes: 120,
    onsiteLunchRecordedMinutes: 60,
    remoteMaxWorkHours: 12,
};
/** Read the active limits from systemSettings/global, tolerating missing/malformed fields. */
async function fetchGuardrailLimits() {
    try {
        const snap = await db.collection('systemSettings').doc('global').get();
        const d = snap.exists ? snap.data() : {};
        const num = (v, dflt) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt;
        const hhmm = (v, dflt) => typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v) ? v : dflt;
        return {
            onsiteLatestAllowedTime: hhmm(d.onsiteLatestAllowedTime, DEFAULT_LIMITS.onsiteLatestAllowedTime),
            onsiteRecordedTime: hhmm(d.onsiteRecordedTime, DEFAULT_LIMITS.onsiteRecordedTime),
            onsiteLunchMaxMinutes: num(d.onsiteLunchMaxMinutes, DEFAULT_LIMITS.onsiteLunchMaxMinutes),
            onsiteLunchRecordedMinutes: num(d.onsiteLunchRecordedMinutes, DEFAULT_LIMITS.onsiteLunchRecordedMinutes),
            remoteMaxWorkHours: num(d.remoteMaxWorkHours, DEFAULT_LIMITS.remoteMaxWorkHours),
        };
    }
    catch (err) {
        functions.logger.error('Failed to read systemSettings/global — using default guardrail limits.', err);
        return DEFAULT_LIMITS;
    }
}
/**
 * Normalize a Firestore Timestamp | number | Date to epoch millis.
 * The client dual-writes both `clockInSystem` (millis) and `clockInSystemTime`
 * (Timestamp), so we accept whichever is present.
 */
function toMillis(value) {
    if (value == null)
        return undefined;
    if (typeof value === 'number')
        return value;
    if (value instanceof Date)
        return value.getTime();
    if (typeof value === 'object' && typeof value.toMillis === 'function') {
        return value.toMillis();
    }
    return undefined;
}
/** Locate the open (not clocked-out) segment in a raw timeEntries doc. */
function getOpenSegment(data) {
    var _a, _b, _c, _d, _e, _f;
    if (!data)
        return null;
    if (data.status === 'voided' || data.status === 'archived')
        return null;
    const segments = Array.isArray(data.segments) ? data.segments : [];
    if (segments.length) {
        const last = segments[segments.length - 1];
        if (last && last.complete !== true) {
            return {
                id: typeof last.id === 'string' ? last.id : undefined,
                taskId: typeof last.taskId === 'string' ? last.taskId : undefined,
                clockInSystem: toMillis((_a = last.clockInSystem) !== null && _a !== void 0 ? _a : last.clockInSystemTime),
                lunchOutSystem: toMillis((_b = last.lunchOutSystem) !== null && _b !== void 0 ? _b : last.lunchOutSystemTime),
                lunchInSystem: toMillis((_c = last.lunchInSystem) !== null && _c !== void 0 ? _c : last.lunchInSystemTime),
                skipLunch: last.skipLunch === true || last.lunchSkipped === true,
            };
        }
    }
    // Legacy flat doc (or top-level-only open shift): clocked in at the top
    // level but never clocked out, while segments[] may end in a CLOSED
    // segment (documented legacy shape — the open shift lives only in the
    // top-level fields).
    if (data.clockInManual && !data.clockOutManual && data.dayComplete !== true) {
        return {
            taskId: typeof data.taskId === 'string' ? data.taskId : undefined,
            clockInSystem: toMillis((_d = data.clockInSystem) !== null && _d !== void 0 ? _d : data.clockInSystemTime),
            lunchOutSystem: toMillis((_e = data.lunchOutSystem) !== null && _e !== void 0 ? _e : data.lunchOutSystemTime),
            lunchInSystem: toMillis((_f = data.lunchInSystem) !== null && _f !== void 0 ? _f : data.lunchInSystemTime),
            skipLunch: data.skipLunch === true || data.lunchSkipped === true,
        };
    }
    return null;
}
/**
 * Split a closed span at local midnights (client midnightSplit.ts parity):
 * the cron must produce the same per-local-date segments a manual punch-out
 * would, or per-date history / weekly totals diverge from an equivalent
 * manually-closed shift. Single-day spans return one part with no split
 * markers. Follows the client convention of stamping a midnight-ending part
 * at 23:59 (epoch midnight - 60s).
 */
function splitClosedSpan(inMs, outMs, tz, loMs, liMs, skipLunch, taskId) {
    const dates = [];
    let cursor = moment_timezone_1.default.tz(inMs, tz).startOf('day');
    const endDay = moment_timezone_1.default.tz(outMs, tz).startOf('day');
    while (cursor.valueOf() <= endDay.valueOf()) {
        dates.push(cursor.format('YYYY-MM-DD'));
        cursor = cursor.clone().add(1, 'day');
    }
    const multi = dates.length > 1;
    return dates.map((date, i) => {
        const dayStart = moment_timezone_1.default.tz(`${date} 00:00`, 'YYYY-MM-DD HH:mm', tz).valueOf();
        const nextDayStart = moment_timezone_1.default.tz(`${date} 00:00`, 'YYYY-MM-DD HH:mm', tz).add(1, 'day').valueOf();
        const partStart = Math.max(inMs, dayStart);
        const rawEnd = Math.min(outMs, nextDayStart);
        const endsAtMidnight = multi && i < dates.length - 1 && rawEnd === nextDayStart;
        const partEnd = endsAtMidnight ? rawEnd - 60000 : rawEnd;
        // Lunch: deduct the overlap with this part; attach the lunch punch
        // fields to the part(s) containing them.
        let lunchMs = 0;
        const lunchFields = {};
        if (!skipLunch && typeof loMs === 'number' && typeof liMs === 'number' && liMs > loMs) {
            lunchMs = Math.max(0, Math.min(liMs, rawEnd) - Math.max(loMs, partStart));
            if (loMs >= partStart && loMs < rawEnd) {
                lunchFields.lunchOutSystem = loMs;
                lunchFields.lunchOutManual = moment_timezone_1.default.tz(loMs, tz).format('HH:mm');
            }
            if (liMs > partStart && liMs <= rawEnd) {
                lunchFields.lunchInSystem = liMs;
                lunchFields.lunchInManual = moment_timezone_1.default.tz(liMs, tz).format('HH:mm');
            }
        }
        return Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ id: `seg_sysclose_${outMs}_${i}` }, (i === 0 && taskId ? { taskId } : {})), { clockInManual: moment_timezone_1.default.tz(partStart, tz).format('HH:mm'), clockInSystem: partStart, clockOutManual: endsAtMidnight ? '23:59' : moment_timezone_1.default.tz(partEnd, tz).format('HH:mm'), clockOutSystem: partEnd }), lunchFields), (skipLunch ? { skipLunch: true } : {})), { workMinutes: Math.max(0, Math.round((partEnd - partStart) / 60000) - Math.round(lunchMs / 60000)) }), (multi ? { localDate: date, splitFromMidnight: true } : {})), { complete: true, autoClosed: true, flagged: true });
    });
}
/** Build the immutable audit row (actor 'system') for a guardrail action. */
function buildAuditDoc(entryId, reason, before, after) {
    return {
        occurredAt: admin.firestore.FieldValue.serverTimestamp(),
        actorUid: 'system',
        actorName: 'System Guardrails',
        actorRole: 'system',
        action: 'time_correction',
        targetCollection: 'timeEntries',
        targetId: entryId,
        before,
        after,
        reason,
    };
}
/**
 * Auto-Guardrails Engine — runs every 15 minutes and evaluates all open time
 * entries against the employee's canonical timezone:
 *
 *   - On-site auto-close at 10:00 PM local.
 *   - Remote auto-close at the 12-hour mark.
 *   - 1-hour lunch auto-end.
 *
 * Every action writes `flagged: true` (+ `autoClosed` / `autoEndedLunch`) and
 * an immutable `auditLogs` row with actor 'system'. Because this runs under the
 * Admin SDK it bypasses Firestore security rules, which is required for the
 * cross-user system write + audit append.
 *
 * Writes run inside a Firestore transaction that (1) RE-READS the doc and
 * re-verifies the shift/lunch is still open — an employee punch-out between
 * the snapshot and the write wins, the cron never clobbers it — and
 * (2) commits the audit row and the timeEntries mutation ATOMICALLY (audit
 * first), so no correction can land without its immutable audit row and no
 * audit row can reference a correction that never happened.
 */
/**
 * Fetch every candidate open-shift doc.
 *
 * Query audit (2026-08-18):
 *  - `dayComplete == false` matches shifts created today AND shifts that
 *    crossed a local midnight while still open: the midnight-split path in
 *    clockService keeps the open segment on the ORIGINAL `${uid}_${date}` doc
 *    (day-2+ docs are only written, already closed, at punch-out), so an open
 *    split shift still carries `dayComplete: false` and is matched here.
 *  - GAP: Firestore `== false` does NOT match docs where `dayComplete` is
 *    missing entirely (legacy rows written before the field existed). Those
 *    are fetched by a second, time-bounded query and merged in.
 */
async function fetchOpenEntryCandidates(nowMs) {
    const byId = new Map();
    const primarySnap = await db.collection('timeEntries')
        .where('dayComplete', '==', false)
        .limit(1000)
        .get();
    for (const d of primarySnap.docs)
        byId.set(d.id, d);
    // Legacy fallback: docs with NO `dayComplete` field. Bounded to shifts
    // started in the last 7 days (a still-open shift older than that is a
    // historical runaway — handled by repairRunawayShifts, not the cron).
    const legacyCutoffMs = nowMs - 7 * 24 * 60 * 60 * 1000;
    const legacySnap = await db.collection('timeEntries')
        .where('clockInSystem', '>', legacyCutoffMs)
        .limit(1000)
        .get();
    for (const d of legacySnap.docs) {
        if (byId.has(d.id))
            continue;
        const data = d.data();
        if (data.dayComplete !== undefined)
            continue; // has the field — primary query owns it
        byId.set(d.id, d);
    }
    return Array.from(byId.values());
}
exports.runAutoGuardrails = functions.pubsub
    .schedule('every 15 minutes')
    .onRun(async () => {
    functions.logger.info('Starting auto-guardrails evaluation...');
    try {
        const usersSnap = await db.collection('users').where('active', '==', true).get();
        const usersById = new Map();
        for (const u of usersSnap.docs)
            usersById.set(u.id, u.data());
        const nowMs = Date.now();
        const limits = await fetchGuardrailLimits();
        functions.logger.info(`Auto-guardrails limits: onsiteLatest=${limits.onsiteLatestAllowedTime} ` +
            `onsiteRecorded=${limits.onsiteRecordedTime} lunchMax=${limits.onsiteLunchMaxMinutes}min ` +
            `lunchRecorded=${limits.onsiteLunchRecordedMinutes}min remoteMax=${limits.remoteMaxWorkHours}h`);
        const candidates = await fetchOpenEntryCandidates(nowMs);
        functions.logger.info(`Auto-guardrails: query returned ${candidates.length} candidate open-entr${candidates.length === 1 ? 'y' : 'ies'}.`);
        for (const docSnap of candidates) {
            const entryId = docSnap.id;
            const data = docSnap.data();
            const userData = usersById.get(String(data.userId || ''));
            if (!userData) {
                functions.logger.info(`Auto-guardrails: skipping ${entryId} — orphaned entry (no active user ${data.userId}).`);
                continue;
            }
            const openSeg = getOpenSegment(data);
            if (!openSeg || typeof openSeg.clockInSystem !== 'number') {
                functions.logger.info(`Auto-guardrails: skipping ${entryId} — no open segment with a system clock-in.`);
                continue;
            }
            const workModel = userData.workModel === 'Remote' ? 'Remote' : 'On-site';
            const timezone = typeof userData.timezone === 'string' && userData.timezone.trim()
                ? userData.timezone
                : DEFAULT_TIMEZONE;
            const elapsedHours = (nowMs - openSeg.clockInSystem) / 3600000;
            functions.logger.info(`Auto-guardrails: evaluating entry=${entryId} user=${data.userId} ` +
                `workModel=${workModel} timezone=${timezone} elapsedHours=${elapsedHours.toFixed(2)}`);
            // --- 1) Shift auto-close (takes precedence over lunch auto-end) ----
            // Trigger vs RECORDED instants (Settings → Automated Actions):
            // the trigger decides WHEN the guardrail fires; the recorded
            // instant is what gets stamped as clockOut (e.g. trigger 22:00
            // records 17:00; trigger 120min lunch records 60min).
            let triggerAtMs = null;
            let recordedMs = null;
            let closeReason = '';
            if (workModel === 'Remote') {
                const candidate = openSeg.clockInSystem + limits.remoteMaxWorkHours * 60 * 60 * 1000;
                if (nowMs >= candidate) {
                    triggerAtMs = candidate;
                    recordedMs = candidate; // remote: trigger == recorded
                    closeReason = `Remote shift reached the ${limits.remoteMaxWorkHours}-hour limit`;
                }
            }
            else {
                const clockInDate = moment_timezone_1.default.tz(openSeg.clockInSystem, timezone).format('YYYY-MM-DD');
                let candidate = moment_timezone_1.default.tz(`${clockInDate} ${limits.onsiteLatestAllowedTime}`, 'YYYY-MM-DD HH:mm', timezone).valueOf();
                if (candidate <= openSeg.clockInSystem) {
                    // Clocked in after the cutoff — close at the next day's cutoff.
                    const nextDate = moment_timezone_1.default.tz(openSeg.clockInSystem + 86400000, timezone).format('YYYY-MM-DD');
                    candidate = moment_timezone_1.default.tz(`${nextDate} ${limits.onsiteLatestAllowedTime}`, 'YYYY-MM-DD HH:mm', timezone).valueOf();
                }
                if (nowMs >= candidate) {
                    triggerAtMs = candidate;
                    // Recorded clock-out: onsiteRecordedTime on the clock-in
                    // local date. Guard: if that would precede the clock-in
                    // (night shift) or postdate the trigger, record the
                    // trigger instant instead — the span must stay positive.
                    let recorded = moment_timezone_1.default.tz(`${clockInDate} ${limits.onsiteRecordedTime}`, 'YYYY-MM-DD HH:mm', timezone).valueOf();
                    if (recorded <= openSeg.clockInSystem || recorded > candidate)
                        recorded = candidate;
                    recordedMs = recorded;
                    closeReason =
                        `On-site shift exceeded ${limits.onsiteLatestAllowedTime} local; ` +
                            `clock-out recorded at ${limits.onsiteRecordedTime} local`;
                }
            }
            if (triggerAtMs !== null && recordedMs !== null) {
                const capMs = triggerAtMs;
                const stampMs = recordedMs;
                const closeOutcome = await db.runTransaction(async (tx) => {
                    var _a, _b, _c, _d, _e, _f;
                    // Re-read inside the transaction: if the employee punched
                    // out (or ended lunch) between the list snapshot and now,
                    // their exact times win — the cron never overwrites a
                    // legitimate punch-out.
                    const fresh = await tx.get(docSnap.ref);
                    if (!fresh.exists)
                        return 'missing';
                    const fd = fresh.data();
                    const fo = getOpenSegment(fd);
                    if (!fo || typeof fo.clockInSystem !== 'number')
                        return 'already-closed';
                    // Lunch clamp vs the RECORDED instant: an in-progress
                    // lunch is ended at the recorded clock-out ONLY when it
                    // started at/before it. A lunch started AFTER the
                    // recorded instant never happened within the recorded
                    // span — clear it rather than persist an inverted
                    // lunchIn < lunchOut.
                    const skipLunch = fo.skipLunch === true;
                    let loMs = skipLunch ? undefined : fo.lunchOutSystem;
                    let liMs = skipLunch ? undefined : fo.lunchInSystem;
                    if (typeof loMs === 'number' && typeof liMs !== 'number') {
                        if (loMs <= stampMs) {
                            liMs = stampMs; // in-progress lunch ends at the recorded close (deducted)
                        }
                        else {
                            loMs = undefined;
                            liMs = undefined;
                        }
                    }
                    const parts = splitClosedSpan(fo.clockInSystem, stampMs, timezone, loMs, liMs, skipLunch, fo.taskId);
                    const part0 = parts[0];
                    // Replace the targeted open segment (by id), or — for the
                    // top-level-only-open legacy shape — append the
                    // materialized shift to the existing segments.
                    const existingSegs = Array.isArray(fd.segments) ? fd.segments : [];
                    const baseSegs = fo.id ? existingSegs.filter((s) => (s === null || s === void 0 ? void 0 : s.id) !== fo.id) : existingSegs;
                    const day1Segments = [...baseSegs, part0];
                    const day1Total = day1Segments.reduce((sum, s) => sum + (typeof s.workMinutes === 'number' ? s.workMinutes : 0), 0);
                    // Firestore transactions require ALL reads before ANY
                    // write: fetch the day-2+ target docs up front.
                    const extraParts = parts.slice(1);
                    const extraRefs = extraParts.map((p) => db.collection('timeEntries').doc(`${fd.userId}_${p.localDate}`));
                    const extraSnaps = await Promise.all(extraRefs.map((r) => tx.get(r)));
                    const serverNow = admin.firestore.FieldValue.serverTimestamp();
                    const ts = (ms) => admin.firestore.Timestamp.fromMillis(ms);
                    // Audit FIRST — atomically with the mutation (same
                    // transaction): no unaudited correction, no orphan audit.
                    const auditRef = db.collection('auditLogs').doc();
                    tx.create(auditRef, buildAuditDoc(entryId, `System auto-closed shift: ${closeReason}.`, {
                        clockInSystem: fo.clockInSystem,
                        lunchOutSystem: (_a = fo.lunchOutSystem) !== null && _a !== void 0 ? _a : null,
                        lunchInSystem: (_b = fo.lunchInSystem) !== null && _b !== void 0 ? _b : null,
                        clockOutSystem: null,
                    }, {
                        triggerAt: capMs,
                        recordedAt: stampMs,
                        parts: parts.length,
                        day1WorkMinutes: day1Total,
                        autoClosed: true,
                        flagged: true,
                    }));
                    // Original doc keeps the Day-1 portion; top-level fields
                    // mirror THAT portion (client split parity — no phantom
                    // spanning "current" shift).
                    tx.update(docSnap.ref, {
                        clockOutManual: part0.clockOutManual,
                        clockOutSystem: part0.clockOutSystem,
                        clockOutSystemTime: ts(part0.clockOutSystem),
                        lunchOutManual: (_c = part0.lunchOutManual) !== null && _c !== void 0 ? _c : null,
                        lunchOutSystem: (_d = part0.lunchOutSystem) !== null && _d !== void 0 ? _d : null,
                        lunchOutSystemTime: part0.lunchOutSystem != null ? ts(part0.lunchOutSystem) : null,
                        lunchInManual: (_e = part0.lunchInManual) !== null && _e !== void 0 ? _e : null,
                        lunchInSystem: (_f = part0.lunchInSystem) !== null && _f !== void 0 ? _f : null,
                        lunchInSystemTime: part0.lunchInSystem != null ? ts(part0.lunchInSystem) : null,
                        complete: true,
                        dayComplete: true,
                        currentStep: 4,
                        completedAt: ts(part0.clockOutSystem),
                        autoClosed: true,
                        flagged: true,
                        segments: day1Segments,
                        totalWorkMinutes: day1Total,
                        totalHours: day1Total / 60,
                        updatedAt: serverNow,
                        updatedBy: 'system',
                    });
                    // Day-2+ docs: one per local date (client split parity).
                    extraParts.forEach((p, i) => {
                        const snap = extraSnaps[i];
                        const ref = extraRefs[i];
                        if (snap.exists) {
                            const ex = snap.data();
                            const exSegs = Array.isArray(ex.segments) ? ex.segments : [];
                            const exTotal = typeof ex.totalWorkMinutes === 'number' ? ex.totalWorkMinutes : 0;
                            // Merge into the existing day doc WITHOUT touching
                            // its completion state — the employee may have an
                            // open shift there already.
                            tx.update(ref, {
                                segments: [...exSegs, p],
                                totalWorkMinutes: exTotal + p.workMinutes,
                                updatedAt: serverNow,
                                updatedBy: 'system',
                            });
                        }
                        else {
                            tx.set(ref, {
                                userId: fd.userId,
                                workDate: p.localDate,
                                clockInManual: p.clockInManual,
                                clockInSystem: p.clockInSystem,
                                clockInSystemTime: ts(p.clockInSystem),
                                clockOutManual: p.clockOutManual,
                                clockOutSystem: p.clockOutSystem,
                                clockOutSystemTime: ts(p.clockOutSystem),
                                complete: true,
                                dayComplete: true,
                                currentStep: 4,
                                completedAt: ts(p.clockOutSystem),
                                autoClosed: true,
                                flagged: true,
                                segments: [p],
                                totalWorkMinutes: p.workMinutes,
                                totalHours: p.workMinutes / 60,
                                createdAt: serverNow,
                                updatedAt: serverNow,
                                updatedBy: 'system',
                            });
                        }
                    });
                    return 'closed';
                });
                if (closeOutcome === 'closed') {
                    functions.logger.info(`Auto-closed shift ${entryId} (${closeReason})`);
                }
                else {
                    functions.logger.info(`Auto-guardrails: skipping ${entryId} — ${closeOutcome === 'missing'
                        ? 'doc deleted'
                        : 'closed between snapshot and transaction (employee punch-out wins)'}.`);
                }
                continue;
            }
            // --- 2) Lunch auto-end (Settings → Automated Actions) ----------------
            // Trigger at onsiteLunchMaxMinutes open; RECORD lunchIn as
            // lunchOut + onsiteLunchRecordedMinutes.
            const lo = openSeg.lunchOutSystem;
            const li = openSeg.lunchInSystem;
            if (typeof lo === 'number' && typeof li !== 'number' && openSeg.skipLunch !== true) {
                const endAtMs = lo + limits.onsiteLunchMaxMinutes * 60 * 1000;
                if (nowMs >= endAtMs) {
                    const lunchInMs = lo + limits.onsiteLunchRecordedMinutes * 60 * 1000;
                    const lunchInManual = moment_timezone_1.default.tz(lunchInMs, timezone).format('HH:mm');
                    const lunchOutcome = await db.runTransaction(async (tx) => {
                        const fresh = await tx.get(docSnap.ref);
                        if (!fresh.exists)
                            return 'missing';
                        const fd = fresh.data();
                        const fo = getOpenSegment(fd);
                        if (!fo ||
                            typeof fo.lunchOutSystem !== 'number' ||
                            typeof fo.lunchInSystem === 'number' ||
                            fo.skipLunch === true) {
                            return 'changed'; // lunch ended / shift closed meanwhile
                        }
                        const serverNow = admin.firestore.FieldValue.serverTimestamp();
                        // Audit FIRST — atomic with the mutation.
                        const auditRef = db.collection('auditLogs').doc();
                        tx.create(auditRef, buildAuditDoc(entryId, 'System auto-ended lunch: open past ' + limits.onsiteLunchMaxMinutes + ' minutes; recorded as ' + limits.onsiteLunchRecordedMinutes + ' minutes.', { lunchOutSystem: fo.lunchOutSystem, lunchInSystem: null }, {
                            lunchInManual,
                            lunchInSystem: lunchInMs,
                            autoEndedLunch: true,
                            flagged: true,
                        }));
                        const patch = {
                            lunchInManual,
                            lunchInSystem: lunchInMs,
                            lunchInSystemTime: admin.firestore.Timestamp.fromMillis(lunchInMs),
                            autoEndedLunch: true,
                            flagged: true,
                            updatedAt: serverNow,
                            updatedBy: 'system',
                        };
                        const segs = Array.isArray(fd.segments) ? fd.segments : [];
                        if (fo.id && segs.length) {
                            patch.segments = segs.map((s) => (s === null || s === void 0 ? void 0 : s.id) === fo.id
                                ? Object.assign(Object.assign({}, s), { lunchInManual, lunchInSystem: lunchInMs, lunchInSystemTime: admin.firestore.Timestamp.fromMillis(lunchInMs), autoEndedLunch: true, flagged: true }) : s);
                        }
                        tx.update(docSnap.ref, patch);
                        return 'ended';
                    });
                    if (lunchOutcome === 'ended') {
                        functions.logger.info(`Auto-ended lunch for ${entryId}`);
                    }
                    else {
                        functions.logger.info(`Auto-guardrails: skipping lunch auto-end for ${entryId} — state changed (${lunchOutcome}).`);
                    }
                }
            }
        }
    }
    catch (error) {
        functions.logger.error('Error in runAutoGuardrails cron job:', error);
    }
    return null;
});
//# sourceMappingURL=autoGuardrails.js.map