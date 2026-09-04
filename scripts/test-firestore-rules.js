/**
 * Firestore Security Rules Unit Test Runner
 *
 * Usage:
 *   1) Start emulators (in another terminal):
 *        firebase emulators:start --only firestore
 *   2) Run:
 *        npm run test:rules
 *
 * Notes:
 * - Uses @firebase/rules-unit-testing v3 which exposes the v8 namespaced API
 *   via the test-environment contexts (ctx.firestore() returns a Firestore
 *   client; we then use .collection().doc() chains instead of v9 modular helpers).
 * - We deliberately do NOT import the v9 modular `firebase/firestore` SDK —
 *   that import auto-initializes a global Firestore client which conflicts
 *   with rules-unit-testing's own client.
 */
import fs from "node:fs";
import net from "node:net";
import assert from "node:assert/strict";

// CRITICAL: set the emulator-host env var BEFORE any firebase import.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "atd-time-tracking";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST.split(":")[0] || "127.0.0.1";
const FIRESTORE_PORT = Number(process.env.FIRESTORE_EMULATOR_HOST.split(":")[1] || 8080);

function canConnect(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.connect(port, host, () => done(true));
  });
}

// Build a DocumentReference from path segments:
//   dref(db, 'users', 'emp-1')  →  db.collection('users').doc('emp-1')
//   dref(db, 'a', '1', 'b', '2')  →  db.collection('a').doc('1').collection('b').doc('2')
function dref(db, ...segments) {
  if (segments.length < 2 || segments.length % 2 !== 0) {
    throw new Error("dref() needs (db, collection, id, [collection, id, ...])");
  }
  let ref = db.collection(segments[0]).doc(segments[1]);
  for (let i = 2; i < segments.length; i += 2) {
    ref = ref.collection(segments[i]).doc(segments[i + 1]);
  }
  return ref;
}

async function main() {
  const ok = await canConnect(FIRESTORE_HOST, FIRESTORE_PORT);
  if (!ok) {
    console.error(
      [
        `❌ Firestore emulator is not reachable at ${FIRESTORE_HOST}:${FIRESTORE_PORT}.`,
        "",
        "Start it in another terminal:",
        "  firebase emulators:start --only firestore",
        "",
        "Then re-run:",
        "  npm run test:rules",
      ].join("\n"),
    );
    process.exit(1);
  }

  const rulesPath = new URL("../firestore.rules", import.meta.url);
  const rules = fs.readFileSync(rulesPath, "utf8");

  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: FIRESTORE_HOST,
      port: FIRESTORE_PORT,
      rules,
    },
  });

  try {
    // Seed users with rules disabled so role checks can work.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await dref(db, "users", "admin-1").set({
        uid: "admin-1",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        active: true,
      });
      await dref(db, "users", "manager-1").set({
        uid: "manager-1",
        email: "manager@example.com",
        name: "Manager",
        role: "manager",
        active: true,
      });
      await dref(db, "users", "emp-1").set({
        uid: "emp-1",
        email: "emp1@example.com",
        name: "Employee 1",
        role: "employee",
        active: true,
      });
      await dref(db, "users", "emp-2").set({
        uid: "emp-2",
        email: "emp2@example.com",
        name: "Employee 2",
        role: "employee",
        active: true,
      });
    });

    const unauth = testEnv.unauthenticatedContext();
    const emp1 = testEnv.authenticatedContext("emp-1");
    const emp2 = testEnv.authenticatedContext("emp-2");
    const manager = testEnv.authenticatedContext("manager-1");
    const admin = testEnv.authenticatedContext("admin-1");

    // Cache firestore clients per context. rules-unit-testing v3 returns the
    // same underlying firebase app on repeated `.firestore()` calls, and
    // `useEmulator()` throws "settings can no longer be changed" on the
    // second call. Caching the instance avoids that.
    const dbOf = (ctx) => {
      if (!ctx.__db) ctx.__db = ctx.firestore();
      return ctx.__db;
    };

    // --- users rules ---
    await assertFails(dref(dbOf(unauth), "users", "emp-1").get());
    await assertSucceeds(dref(dbOf(emp1), "users", "emp-1").get());
    await assertFails(dref(dbOf(emp1), "users", "emp-2").get());
    await assertSucceeds(dref(dbOf(manager), "users", "emp-2").get());
    await assertSucceeds(dref(dbOf(admin), "users", "emp-2").get());

    // Employees may update their OWN profile, but only self-service fields
    // (timezone + updatedAt). Protected fields remain admin-only.
    await assertSucceeds(
      dref(dbOf(emp1), "users", "emp-1").set({ timezone: "Asia/Bangkok" }, { merge: true }),
    );
    await assertSucceeds(
      dref(dbOf(emp1), "users", "emp-1").set(
        { timezone: "Asia/Bangkok", updatedAt: new Date() },
        { merge: true },
      ),
    );

    // employee cannot update protected fields (name, role, workModel, active)
    await assertFails(
      dref(dbOf(emp1), "users", "emp-1").set({ name: "Employee 1 Updated" }, { merge: true }),
    );
    await assertFails(
      dref(dbOf(emp1), "users", "emp-1").set({ role: "admin" }, { merge: true }),
    );
    await assertFails(
      dref(dbOf(emp1), "users", "emp-1").set({ workModel: "Remote" }, { merge: true }),
    );
    await assertFails(
      dref(dbOf(emp1), "users", "emp-1").set({ active: false }, { merge: true }),
    );

    // employee cannot update another user's profile
    await assertFails(
      dref(dbOf(emp1), "users", "emp-2").set({ timezone: "Asia/Bangkok" }, { merge: true }),
    );

    // admin can still update any user field
    await assertSucceeds(
      dref(dbOf(admin), "users", "emp-1").set({ name: "Employee 1 Updated" }, { merge: true }),
    );

    // --- timeEntries rules ---
    const entryId1 = "emp-1_2025-12-22";
    const entryId2 = "emp-2_2025-12-22";

    await assertSucceeds(
      dref(dbOf(emp1), "timeEntries", entryId1).set({
        userId: "emp-1",
        workDate: "2025-12-22",
        currentStep: "clockIn",
        clockInManual: "08:00",
        clockInSubmitted: true,
        dayComplete: false,
      }),
    );

    // employee cannot write someone else's entry
    await assertFails(
      dref(dbOf(emp1), "timeEntries", entryId2).set({
        userId: "emp-2",
        workDate: "2025-12-22",
      }),
    );

    // manager can read others' entries
    await assertSucceeds(dref(dbOf(manager), "timeEntries", entryId1).get());

    // employee cannot delete
    await assertFails(dref(dbOf(emp1), "timeEntries", entryId1).delete());
    // admin can delete
    await assertSucceeds(dref(dbOf(admin), "timeEntries", entryId1).delete());

    // employee can update their own entry (and must be active)
    await assertSucceeds(
      dref(dbOf(emp2), "timeEntries", entryId2).set(
        {
          userId: "emp-2",
          workDate: "2025-12-22",
          currentStep: "clockIn",
          clockInManual: "08:00",
          clockInSubmitted: true,
          dayComplete: false,
        },
        { merge: true },
      ),
    );

    // --- auditLogs rules (Phase 1) ---
    const auditLogId = "test-audit-log-1";
    const validAuditLog = {
      occurredAt: new Date(),
      actorUid: "admin-1",
      actorRole: "admin",
      action: "time_correction",
      targetCollection: "timeEntries",
      targetId: entryId2,
      before: { clockInManual: "08:00" },
      after: { clockInManual: "08:15" },
      reason: "Employee arrived at 8:15, not 8:00",
    };

    // admin can create audit log with valid fields
    await assertSucceeds(
      dref(dbOf(admin), "auditLogs", auditLogId).set(validAuditLog),
    );

    // admin CAN create audit log without reason (policy change 2026-08:
    // admin edits are exempt from mandatory audit notes)
    await assertSucceeds(
      dref(dbOf(admin), "auditLogs", "test-audit-no-reason").set({
        ...validAuditLog,
        reason: "",
      }),
    );

    // manager CAN create audit log without reason (same exemption as admin)
    await assertSucceeds(
      dref(dbOf(manager), "auditLogs", "test-audit-mgr-no-reason").set({
        occurredAt: new Date(),
        actorUid: "manager-1",
        actorRole: "manager",
        action: "time_correction",
        targetCollection: "timeEntries",
        targetId: "emp-1_2025-12-22",
        before: { clockInManual: "08:00" },
        after: { clockInManual: "08:15" },
        reason: "",
      }),
    );

    // manager CAN create audit log with reason (redundant but ensures
    // both branches work)
    await assertSucceeds(
      dref(dbOf(manager), "auditLogs", "test-audit-mgr-with-reason").set({
        occurredAt: new Date(),
        actorUid: "manager-1",
        actorRole: "manager",
        action: "time_correction",
        targetCollection: "timeEntries",
        targetId: "emp-1_2025-12-22",
        before: { clockInManual: "08:00" },
        after: { clockInManual: "08:15" },
        reason: "Manager correction with reason",
      }),
    );

    // employee CANNOT create audit log without reason (employee path still
    // enforces mandatory reason for self-edits)
    await assertFails(
      dref(dbOf(emp1), "auditLogs", "test-audit-emp-no-reason").set({
        occurredAt: new Date(),
        actorUid: "emp-1",
        actorRole: "employee",
        action: "time_correction",
        targetCollection: "timeEntries",
        targetId: "emp-1_2025-12-22",
        before: { clockInManual: "08:00" },
        after: { clockInManual: "08:15" },
        reason: "",
      }),
    );

    // admin cannot create audit log without targetCollection
    await assertFails(
      dref(dbOf(admin), "auditLogs", "test-audit-no-target").set({
        occurredAt: new Date(),
        actorUid: "admin-1",
        reason: "test",
      }),
    );

    // manager can read audit logs
    await assertSucceeds(dref(dbOf(manager), "auditLogs", auditLogId).get());

    // employee cannot read audit logs
    await assertFails(dref(dbOf(emp1), "auditLogs", auditLogId).get());

    // unauthenticated cannot read audit logs
    await assertFails(dref(dbOf(unauth), "auditLogs", auditLogId).get());

    // IMMUTABLE: admin cannot update audit log
    await assertFails(
      dref(dbOf(admin), "auditLogs", auditLogId).set(
        { reason: "modified reason" },
        { merge: true },
      ),
    );

    // IMMUTABLE: admin cannot delete audit log
    await assertFails(dref(dbOf(admin), "auditLogs", auditLogId).delete());

    // IMMUTABLE: manager cannot delete audit log
    await assertFails(dref(dbOf(manager), "auditLogs", auditLogId).delete());

    // employee cannot create audit log
    await assertFails(
      dref(dbOf(emp1), "auditLogs", "test-audit-emp-create").set(validAuditLog),
    );

    // manager cannot create audit log
    await assertFails(
      dref(dbOf(manager), "auditLogs", "test-audit-mgr-create").set(validAuditLog),
    );

    // --- correctionRequests rules ---
    const corrReqId = "test-corr-req-1";

    // employee can create correction request for themselves
    await assertSucceeds(
      dref(dbOf(emp1), "correctionRequests", corrReqId).set({
        employee_id: "emp-1",
        requested_date: "2025-12-22",
        issue_type: "Wrong Time",
        notes: "Test note",
        status: "Open",
        created_at: Date.now(),
      }),
    );

    // manager cannot update correction requests (rules: admin only)
    await assertFails(
      dref(dbOf(manager), "correctionRequests", corrReqId).set(
        { status: "Resolved", resolution_note: "Approved" },
        { merge: true },
      ),
    );

    // admin can update correction requests
    await assertSucceeds(
      dref(dbOf(admin), "correctionRequests", corrReqId).set(
        { status: "Resolved", resolution_note: "Approved" },
        { merge: true },
      ),
    );

    // --- timeEntries.userId immutability on update ---
    const entryId3 = "emp-1_2025-12-23";
    await assertSucceeds(
      dref(dbOf(emp1), "timeEntries", entryId3).set({
        userId: "emp-1",
        workDate: "2025-12-23",
        currentStep: "clockIn",
        clockInManual: "09:00",
        clockInSubmitted: true,
        dayComplete: false,
      }),
    );

    // employee cannot change userId on their entry to someone else's userId
    await assertFails(
      dref(dbOf(emp1), "timeEntries", entryId3).set(
        { userId: "emp-2" },
        { merge: true },
      ),
    );

    // --- inactive user cannot write timeEntries ---
    // Seed an inactive user
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await dref(db, "users", "inactive-1").set({
        uid: "inactive-1",
        email: "inactive@example.com",
        name: "Inactive User",
        role: "employee",
        active: false,
      });
    });

    const inactiveCtx = testEnv.authenticatedContext("inactive-1");
    await assertFails(
      dref(dbOf(inactiveCtx), "timeEntries", "inactive-1_2025-12-23").set({
        userId: "inactive-1",
        workDate: "2025-12-23",
        currentStep: "clockIn",
        clockInManual: "09:00",
        clockInSubmitted: true,
        dayComplete: false,
      }),
    );

    // inactive user cannot update their own entry
    // First create as admin (active) then try to update as inactive
    await assertSucceeds(
      dref(dbOf(admin), "timeEntries", "inactive-1_2025-12-24").set({
        userId: "inactive-1",
        workDate: "2025-12-24",
        currentStep: "clockIn",
        clockInManual: "09:00",
        clockInSubmitted: true,
        dayComplete: false,
      }),
    );

    await assertFails(
      dref(dbOf(inactiveCtx), "timeEntries", "inactive-1_2025-12-24").set(
        { clockOutManual: "17:00" },
        { merge: true },
      ),
    );

    // --- status transitions ---
    // voided entry can only be modified by admin (not employee)
    await assertSucceeds(
      dref(dbOf(admin), "timeEntries", "inactive-1_2025-12-24").set(
        { status: "voided", voidReason: "Test void" },
        { merge: true },
      ),
    );

    // employee cannot change voided entry back to active
    await assertFails(
      dref(dbOf(emp1), "timeEntries", "inactive-1_2025-12-24").set(
        { status: "active" },
        { merge: true },
      ),
    );

    // --- systemSettings rules ---
    // all authenticated users can read payroll settings
    await assertSucceeds(dref(dbOf(emp1), "systemSettings", "payroll").get());

    // only admin can write system settings
    await assertFails(
      dref(dbOf(emp1), "systemSettings", "payroll").set(
        { locked_up_to_date: "2025-12-01" },
        { merge: true },
      ),
    );

    await assertSucceeds(
      dref(dbOf(admin), "systemSettings", "payroll").set(
        { locked_up_to_date: "2025-12-01" },
        { merge: true },
      ),
    );

    console.log("✅ Firestore rules tests passed.");
    assert.ok(true);
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error("❌ Firestore rules tests failed:");
  console.error(err);
  console.error("--- STACK ---");
  console.error(err.stack);
  process.exit(1);
});
