import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

const PROJECT_ID = 'atd-time-tracking';
const AUTH_EMULATOR = 'http://127.0.0.1:9099';
const FIRESTORE_RULES_PATH = path.resolve(process.cwd(), 'firestore.rules');

const USERS = [
  { email: 'admin@test.local', password: 'Test123!', name: 'Test Admin', role: 'admin' },
  { email: 'manager@test.local', password: 'Test123!', name: 'Test Manager', role: 'manager' },
  { email: 'employee@test.local', password: 'Test123!', name: 'Test Employee', role: 'employee' },
];

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText || 'Request failed';
    const err = new Error(msg);
    err.details = json;
    throw err;
  }
  return json;
}

async function ensureAuthUser(email, password) {
  const signUpUrl = `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`;
  const signInUrl = `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`;

  try {
    const created = await postJson(signUpUrl, { email, password, returnSecureToken: true });
    return { uid: created.localId, idToken: created.idToken, created: true };
  } catch (e) {
    // If it already exists, sign in to retrieve localId
    if (String(e.message).includes('EMAIL_EXISTS')) {
      const signedIn = await postJson(signInUrl, { email, password, returnSecureToken: true });
      return { uid: signedIn.localId, idToken: signedIn.idToken, created: false };
    }
    throw e;
  }
}

async function main() {
  console.log('[seed] Starting seed-test-users...');
  console.log('[seed] Project:', PROJECT_ID);

  // Initialize Firestore test environment so we can write profiles with rules disabled
  const rules = fs.readFileSync(FIRESTORE_RULES_PATH, 'utf8');
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules,
    },
  });

  try {
    const results = [];

    for (const u of USERS) {
      const authUser = await ensureAuthUser(u.email, u.password);

      // Write the Firestore profile with rules disabled (bootstrap problem for admin/manager roles)
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const fdb = context.firestore();
        await setDoc(doc(fdb, 'users', authUser.uid), {
          uid: authUser.uid,
          email: u.email.toLowerCase(),
          name: u.name,
          role: u.role,
          active: true,
          createdAt: new Date(),
          createdBy: 'seed-test-users',
        });
      });

      results.push({ ...u, uid: authUser.uid, created: authUser.created });
      console.log(`[seed] OK ${u.role}: ${u.email} (uid=${authUser.uid}) ${authUser.created ? '[created]' : '[exists]'}`);
    }

    console.log('\n[seed] Done. Use these credentials:');
    for (const r of results) {
      console.log(`- ${r.role}: ${r.email} / ${r.password}`);
    }
    console.log('\n[seed] Tip: run your app locally without ?prod to use emulators; add ?strict to re-enable entry restrictions.');
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error('[seed] FAILED:', err?.message || err);
  if (err?.details) console.error('[seed] Details:', JSON.stringify(err.details, null, 2));
  process.exit(1);
});

