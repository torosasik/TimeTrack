// Create Admin User Script
// Run this with: node create-admin.js

import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, doc, setDoc } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyC_6fkVeub7ZJp4yzSAIp6yZEsrhRk5lQI",
    authDomain: "atd-time-tracking.firebaseapp.com",
    projectId: "atd-time-tracking",
    storageBucket: "atd-time-tracking.firebasestorage.app",
    messagingSenderId: "115771623376",
    appId: "1:115771623376:web:214008a8dfa2007f731bd5"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

async function createAdminUser() {
    const email = 'torosasik@americantiledepot.com';
    const password = 'Admin123!'; // You can change this
    const name = 'Toros Asik';

    try {
        console.log('Creating admin user...');

        // Create user in Firebase Auth
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        console.log('✅ User created in Firebase Auth:', user.uid);

        // Create user document in Firestore
        await setDoc(doc(db, 'users', user.uid), {
            uid: user.uid,
            email: email,
            name: name,
            role: 'admin',
            active: true,
            createdAt: new Date(),
            createdBy: 'system'
        });

        console.log('✅ User document created in Firestore');
        console.log('\n🎉 Admin user created successfully!');
        console.log('📧 Email:', email);
        console.log('🔑 Password:', password);
        console.log('\nYou can now login at: https://atd-time-tracking.web.app');

        process.exit(0);
    } catch (error) {
        if (error.code === 'auth/email-already-in-use') {
            console.log('✅ User already exists! You can login with your existing password.');
            console.log('If you forgot your password, use the "Forgot Password" link.');
        } else {
            console.error('❌ Error creating user:', error.message);
        }
        process.exit(1);
    }
}

createAdminUser();
