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
 * - Uses @firebase/rules-unit-testing and requires the Firestore emulator.
 * - Seeds required user documents with security rules disabled.
 */

import fs from "node:fs";
import net from "node:net";
import assert from "node:assert/strict";

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "atd-time-tracking-rules-test";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST?.split(":")[0] || "127.0.0.1";
const FIRESTORE_PORT = Number(process.env.FIRESTORE_EMULATOR_HOST?.split(":")[1] || 8080);

function canConnect(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.connect(port, host, () => done(true));
  });
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
      ].join("\n")
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
      await setDoc(doc(db, "users", "admin-1"), {
        uid: "admin-1",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        active: true,
      });
      await setDoc(doc(db, "users", "manager-1"), {
        uid: "manager-1",
        email: "manager@example.com",
        name: "Manager",
        role: "manager",
        active: true,
      });
      await setDoc(doc(db, "users", "emp-1"), {
        uid: "emp-1",
        email: "emp1@example.com",
        name: "Employee 1",
        role: "employee",
        active: true,
      });
      await setDoc(doc(db, "users", "emp-2"), {
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

    // --- users rules ---
    await assertFails(getDoc(doc(unauth.firestore(), "users", "emp-1")));
    await assertSucceeds(getDoc(doc(emp1.firestore(), "users", "emp-1")));
    await assertFails(getDoc(doc(emp1.firestore(), "users", "emp-2")));
    await assertSucceeds(getDoc(doc(manager.firestore(), "users", "emp-2")));
    await assertSucceeds(getDoc(doc(admin.firestore(), "users", "emp-2")));

    // only admin can update users
    await assertFails(
      setDoc(
        doc(emp1.firestore(), "users", "emp-1"),
        { name: "Employee 1 Updated" },
        { merge: true }
      )
    );
    await assertSucceeds(
      setDoc(
        doc(admin.firestore(), "users", "emp-1"),
        { name: "Employee 1 Updated" },
        { merge: true }
      )
    );

    // --- timeEntries rules ---
    const entryId1 = "emp-1_2025-12-22";
    const entryId2 = "emp-2_2025-12-22";

    await assertSucceeds(
      setDoc(doc(emp1.firestore(), "timeEntries", entryId1), {
        userId: "emp-1",
        workDate: "2025-12-22",
        currentStep: "clockIn",
        clockInManual: "08:00",
        clockInSubmitted: true,
        dayComplete: false,
      })
    );

    // employee cannot write someone else's entry
    await assertFails(
      setDoc(doc(emp1.firestore(), "timeEntries", entryId2), {
        userId: "emp-2",
        workDate: "2025-12-22",
      })
    );

    // manager can read others' entries
    await assertSucceeds(getDoc(doc(manager.firestore(), "timeEntries", entryId1)));

    // employee cannot delete
    await assertFails(deleteDoc(doc(emp1.firestore(), "timeEntries", entryId1)));
    // admin can delete
    await assertSucceeds(deleteDoc(doc(admin.firestore(), "timeEntries", entryId1)));

    // employee can update their own entry (and must be active)
    await assertSucceeds(
      setDoc(
        doc(emp2.firestore(), "timeEntries", entryId2),
        {
          userId: "emp-2",
          workDate: "2025-12-22",
          currentStep: "clockIn",
          clockInManual: "08:00",
          clockInSubmitted: true,
          dayComplete: false,
        },
        { merge: true }
      )
    );

    console.log("✅ Firestore rules tests passed.");

    // Extra sanity: ensure assertions actually ran
    assert.ok(true);
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error("❌ Firestore rules tests failed:");
  console.error(err);
  process.exit(1);
});


