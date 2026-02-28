import process from 'node:process';

import { signInWithEmailAndPassword } from 'firebase/auth';

// Use the same Firebase project config as the app
import { auth } from '../src/firebase.js';
import { provisionUser } from '../src/services/authService.js';

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main() {
  const adminEmail = mustEnv('ADMIN_EMAIL');
  const adminPassword = mustEnv('ADMIN_PASSWORD');
  const testPassword = mustEnv('TEST_PASSWORD'); // must be >= 6 chars for Firebase Auth

  if (String(testPassword).length < 6) {
    throw new Error('TEST_PASSWORD must be at least 6 characters');
  }

  console.log('[prod-seed] Signing in as admin...');
  const cred = await signInWithEmailAndPassword(auth, adminEmail, adminPassword);
  const adminUid = cred.user.uid;
  console.log('[prod-seed] Admin signed in (uid=%s)', adminUid);

  const usersToCreate = [
    { email: 'employee@test.com', name: 'Test Employee', role: 'employee' },
    { email: 'manager@test.com', name: 'Test Manager', role: 'manager' },
  ];

  for (const u of usersToCreate) {
    console.log(`[prod-seed] Provisioning ${u.role}: ${u.email} ...`);
    const result = await provisionUser({
      email: u.email,
      name: u.name,
      role: u.role,
      createdByUid: adminUid,
      sendInvite: false,
      password: testPassword,
    });
    console.log('[prod-seed] OK %s: %s (status=%s uid=%s)', u.role, u.email, result?.status, result?.uid || 'n/a');
  }

  console.log('[prod-seed] Done.');
}

main().catch((err) => {
  console.error('[prod-seed] FAILED:', err?.message || err);
  process.exit(1);
});

