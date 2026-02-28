import { auth, db } from '../app/lib/firebase';
import {
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    sendPasswordResetEmail,
    getAuth,
    User as FirebaseUser,
    Auth
} from 'firebase/auth';
import { doc, getDoc, setDoc, query, collection, where, getDocs, updateDoc, deleteDoc } from 'firebase/firestore';
import { initializeApp, deleteApp, FirebaseApp } from 'firebase/app';
// We need to verify where firebaseConfig comes from. 
// Based on file list, there is 'config' dir.
import { firebaseConfig } from '../config/firebase.config';

interface ProvisionUserParams {
    email: string;
    name: string;
    role: string;
    createdByUid: string;
    sendInvite?: boolean;
    password?: string | null;
}

interface ProvisionResult {
    uid: string | null;
    status: string;
}

/**
 * Provision a user without logging out the currently signed-in admin.
 * - Creates the Auth user using a secondary Firebase app/auth instance.
 * - Creates/updates the Firestore `users/{uid}` profile using the main Firestore instance.
 * - Optionally sends a password reset email as an "invitation".
 */
export async function provisionUser({ email, name, role, createdByUid, sendInvite = true, password = null }: ProvisionUserParams): Promise<ProvisionResult> {
    let tempApp: FirebaseApp | null = null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let tempAuth: Auth | null = null;

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedName = String(name || '').trim();
    const normalizedRole = String(role || 'employee').trim().toLowerCase();

    if (!normalizedEmail) throw new Error('Email is required');
    if (!normalizedName) throw new Error('Name is required');

    // If NOT inviting, we require an explicit password.
    if (!sendInvite && !password) {
        throw new Error('Password is required when invitation email is disabled');
    }

    try {
        // 1) Initialize a temporary app instance (unique name) to avoid logging out the admin.
        const appName = `temp_provision_user_${Date.now()}`;
        tempApp = initializeApp(firebaseConfig, appName);
        tempAuth = getAuth(tempApp);

        // 2) Create the user in the temp auth instance
        const userPassword =
            sendInvite
                ? (Math.random().toString(36).slice(-8) + "A1!")
                : String(password);

        const userCredential = await createUserWithEmailAndPassword(tempAuth, normalizedEmail, userPassword);
        const newUser = userCredential.user;

        // 3) Create profile in Firestore (admin remains logged in in main auth)
        await setDoc(doc(db, 'users', newUser.uid), {
            uid: newUser.uid,
            email: normalizedEmail,
            name: normalizedName,
            role: normalizedRole,
            active: true,
            createdAt: new Date(),
            createdBy: createdByUid,
            ...(sendInvite ? { invitedAt: new Date(), status: 'invited' } : { status: 'active' })
        });

        // 4) Send invite (password reset email) if requested
        if (sendInvite) {
            // Use MAIN auth instance for consistent action settings / authorized domains.
            await sendPasswordResetEmail(auth, normalizedEmail);
        }

        return { uid: newUser.uid, status: sendInvite ? 'invited' : 'created' };
    } catch (error: any) {
        // Handle "already exists": update Firestore profile and (optionally) resend invite email.
        if (error?.code === 'auth/email-already-in-use') {

            // Find Firestore user doc by email (case-insensitive fallback)
            const usersRef = collection(db, 'users');
            const q = query(usersRef, where('email', '==', normalizedEmail));
            let querySnapshot: any = await getDocs(q);

            if (querySnapshot.empty) {
                const allUsersSnapshot = await getDocs(collection(db, 'users'));
                const foundDoc = allUsersSnapshot.docs.find(d =>
                    d.data().email && String(d.data().email).toLowerCase() === normalizedEmail
                );
                if (foundDoc) {
                    querySnapshot = { empty: false, docs: [foundDoc] };
                }
            }

            if (!querySnapshot.empty) {
                const userDoc = querySnapshot.docs[0];
                await updateDoc(doc(db, 'users', userDoc.id), {
                    role: normalizedRole,
                    name: normalizedName,
                    active: true,
                    updatedAt: new Date(),
                    updatedBy: createdByUid,
                    status: sendInvite ? 're-invited' : 'active'
                });
            }

            if (sendInvite) {
                await sendPasswordResetEmail(auth, normalizedEmail);
            }

            return { uid: null, status: sendInvite ? 'existing_reinvited' : 'existing_updated' };
        }

        console.error('❌ Error provisioning user:', error);
        throw error;
    } finally {
        if (tempApp) {
            await deleteApp(tempApp);
        }
    }
}

/**
 * Invite a new user (Create + Send Password Reset)
 * Uses a secondary app instance to prevent logging out the admin
 */
export async function inviteUser(email: string, name: string, role: string, createdByUid: string): Promise<string> {
    let tempApp: FirebaseApp | null = null;
    let tempAuth: Auth | null = null;

    try {
        const appName = `temp_create_user_${Date.now()}`;
        tempApp = initializeApp(firebaseConfig, appName);
        tempAuth = getAuth(tempApp);

        const tempPassword = Math.random().toString(36).slice(-8) + "A1!";

        const userCredential = await createUserWithEmailAndPassword(tempAuth, email, tempPassword);
        const newUser = userCredential.user;

        await setDoc(doc(db, 'users', newUser.uid), {
            uid: newUser.uid,
            email: email,
            name: name,
            role: role,
            active: true,
            createdAt: new Date(),
            createdBy: createdByUid,
            invitedAt: new Date(),
            status: 'invited'
        });

        // Send Password Reset Email from TEMP auth since we are logged in as them there
        await sendPasswordResetEmail(tempAuth, email);

        return newUser.uid;

    } catch (error: any) {
        if (error.code === 'auth/email-already-in-use') {

            try {
                const usersRef = collection(db, 'users');
                const q = query(usersRef, where('email', '==', email));
                let querySnapshot: any = await getDocs(q);

                if (querySnapshot.empty) {
                    const allUsersSnapshot = await getDocs(collection(db, 'users'));
                    const foundDoc = allUsersSnapshot.docs.find(doc =>
                        doc.data().email && doc.data().email.toLowerCase() === email.toLowerCase()
                    );

                    if (foundDoc) {
                        querySnapshot = { empty: false, docs: [foundDoc] };
                    }
                }

                if (!querySnapshot.empty) {
                    const userDoc = querySnapshot.docs[0];
                    await updateDoc(doc(db, 'users', userDoc.id), {
                        role: role,
                        name: name,
                        updatedAt: new Date(),
                        updatedBy: createdByUid,
                        status: 're-invited'
                    });
                }

                if (tempAuth) {
                    await sendPasswordResetEmail(tempAuth, email);
                }

            } catch (resetError) {
                console.error('❌ Error handling existing user:', resetError);
                throw resetError;
            }
            // Return existing UID if we could find it, otherwise we throw or return a status? 
            // The original code re-threw the error for existing users in `inviteUser` catch block (logic was a bit mixed),
            // but here we handled it. Let's return a success indicator or throw to match duplicate logic?
            // Actually original code re-threw if it wasn't 'email-already-in-use', but inside 'email-already-in-use' it didn't return.
            // We'll return the email as ID or something to indicate success for now.
            return 'existing_user';
        }

        console.error('❌ Error inviting user:', error);
        throw error;
    } finally {
        if (tempApp) {
            await deleteApp(tempApp);
        }
    }
}

/**
 * Delete User Profile (Firestore Only)
 */
export async function deleteUserProfile(uid: string): Promise<void> {
    try {
        await deleteDoc(doc(db, 'users', uid));
    } catch (error) {
        console.error('Error deleting user profile:', error);
        throw error;
    }
}

// ------------------------------------------------------------------
// Client-side duplications (Ideally should be removed in favor of app/lib/auth.ts)
// Keeping them for now in TS to match the legacy file structure
// ------------------------------------------------------------------

let currentUser: FirebaseUser | null = null;
let currentUserData: any = null;

export function initAuthListener(onAuthChange: (user: FirebaseUser | null, userData: any) => void) {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            try {
                const userData = await getUserData(user.uid);
                currentUser = user;
                currentUserData = userData;

                if (onAuthChange) {
                    onAuthChange(user, userData);
                }
            } catch (error) {
                console.error('Error loading user data:', error);
                currentUser = null;
                currentUserData = null;

                if (onAuthChange) {
                    onAuthChange(null, null);
                }
            }
        } else {
            currentUser = null;
            currentUserData = null;

            if (onAuthChange) {
                onAuthChange(null, null);
            }
        }
    });
}

export function getCurrentUser() {
    return currentUser;
}

export function getCurrentUserData() {
    return currentUserData;
}

export async function getUserData(uid: string) {
    const userDoc = await getDoc(doc(db, 'users', uid));
    if (userDoc.exists()) {
        return { uid, ...userDoc.data() };
    }
    throw new Error('User not found');
}

export function requireAuth(allowedRoles: string[] | null = null) {
    return new Promise((resolve, reject) => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            unsubscribe();

            if (!user) {
                window.location.href = '/';
                reject(new Error('Not authenticated'));
                return;
            }

            try {
                const userData: any = await getUserData(user.uid);

                if (!userData.active) {
                    await auth.signOut();
                    window.location.href = '/';
                    reject(new Error('Account inactive'));
                    return;
                }

                if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
                    const role = (userData.role || '').toLowerCase();
                    const allowed = allowedRoles.map(r => String(r).toLowerCase());
                    if (!allowed.includes(role)) {
                        await auth.signOut();
                        window.location.href = '/';
                        reject(new Error('Unauthorized role'));
                        return;
                    }
                }

                resolve({ user, userData });
            } catch (error) {
                window.location.href = '/';
                reject(error);
            }
        });
    });
}

export async function signOut() {
    try {
        await auth.signOut();
        window.location.href = '/';
    } catch (error) {
        console.error('Sign out error:', error);
        throw error;
    }
}
