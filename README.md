# TimeTrack - Employee Time Tracking System

A secure Firebase-based employee time tracking web application with role-based access control.

## 🎯 Features

- ✅ **Manual Time Entry** - Employees enter clock in/out and lunch times
- 🔒 **Locked Submissions** - Entries become read-only after submission
- 👥 **Role-Based Access** - Admin, Manager, and Employee roles with distinct permissions
- 📊 **Audit Trail** - Complete history of all edits with timestamps
- ⚠️ **Lunch Warnings** - Red flags for lunch < 30min or > 60min
- 🚫 **Yesterday Blocking** - Prevents today's entry if yesterday is incomplete
- 📁 **Reporting & Export** - Date range reports with CSV export

## 📚 Operational docs

- `ONBOARDING_RUNBOOK.md` - Create users + employee quick-start
- `WEEK1_OPERATIONS.md` - Week-1 monitoring + payroll checklist

## 📋 Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Firebase account
- Your domain for hosting (e.g., `time.yourcompany.com`)

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Firebase

#### Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project"
3. Follow the setup wizard
4. Enable **Authentication** (Email/Password provider)
5. Enable **Firestore Database**

#### Get Firebase Config

1. In Firebase Console → Project Settings → General
2. Scroll to "Your apps" → Click "Web" icon (</>) 
3. Register your app
4. Copy the `firebaseConfig` object

#### Update Configuration

Edit `src/config/firebase.config.js` and replace the placeholder values:

```javascript
export const firebaseConfig = {
  apiKey: "YOUR_ACTUAL_API_KEY",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project-id.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};

export const APP_DOMAIN = "yourcompany.com";
```

### 3. Deploy Firestore Rules & Indexes

```bash
# Login to Firebase
firebase login

# Initialize Firebase in this project
firebase init

# Select:
# - Firestore (rules and indexes)
# - Hosting
# - Use existing project (select your project)
# - Use default firestore.rules and firestore.indexes.json
# - Set public directory to: dist
# - Configure as single-page app: Yes
# - Don't overwrite existing files

# Deploy rules and indexes
firebase deploy --only firestore:rules,firestore:indexes
```

### 4. Create First Admin User

Since there's no public sign-up, the first admin must be created manually:

1. Go to Firebase Console → Authentication
2. Click "Add user"
3. Enter email and password
4. Note the User UID

Then, add this user to Firestore:

1. Go to Firestore Database
2. Create collection: `users`
3. Add document (use the User UID as document ID):

```json
{
  "uid": "the-user-uid-from-auth",
  "name": "Admin User",
  "email": "admin@yourcompany.com",
  "role": "admin",
  "active": true,
  "createdAt": <use Firebase Timestamp>,
  "createdBy": "system"
}
```

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

## 🏗️ Project Structure

```
TimeTrack/
├── src/
│   ├── auth/
│   │   ├── login.html          # Login page
│   │   └── login.js            # Login logic
│   ├── employee/               # Employee pages (to be created)
│   ├── manager/                # Manager pages (to be created)
│   ├── admin/                  # Admin pages (to be created)
│   ├── services/
│   │   └── authService.js      # Auth state management
│   ├── utils/
│   │   ├── dateHelpers.js      # Date utilities
│   │   ├── timeCalculations.js # Time validation & calculations
│   │   └── permissions.js      # Permission checks
│   ├── styles/
│   │   ├── main.css            # Global styles & design system
│   │   └── auth.css            # Auth page styles
│   ├── config/
│   │   └── firebase.config.js  # Firebase configuration
│   ├── firebase.js             # Firebase initialization
│   └── main.js                 # App entry point
├── firebase.json               # Firebase hosting config
├── firestore.rules            # Security rules
├── firestore.indexes.json     # Database indexes
├── package.json
└── README.md
```

## 🔐 Permission Matrix

| Role     | Create Entry | Edit Own Entry | Edit Others | Manage Users |
|----------|--------------|----------------|-------------|--------------|
| Employee | ✅ Once      | ❌              | ❌           | ❌            |
| Manager  | ❌           | ❌              | ✅           | ❌            |
| Admin    | ❌           | ✅              | ✅           | ✅            |

## 📝 Business Rules

### Yesterday Blocking
- On login, system checks if yesterday's entry exists and is complete
- If missing or incomplete, user cannot enter today's time
- Modal blocks access until yesterday is fixed

### Time Validation (Hard Errors)
- Clock out must be after clock in
- Lunch out must be after clock in
- Lunch in must be after lunch out
- Clock out must be after lunch in
- Both lunch times required or neither

### Lunch Warnings (Red Flags)
- Lunch > 60 minutes → Warning
- Lunch < 30 minutes → Warning
- Warnings visible to all roles
- Included in reports

## 🌐 Deployment to Custom Domain

### Firebase Hosting Setup

```bash
# Build production bundle
npm run build

# Deploy to Firebase Hosting
firebase deploy --only hosting
```

### Custom Domain Configuration

1. In Firebase Console → Hosting → Add custom domain
2. Enter: `time.yourcompany.com`
3. Firebase will provide DNS records

4. In your domain provider's DNS settings, add:
   ```
   Type: CNAME
   Name: time
   Value: <provided by Firebase>
   ```

5. Wait for DNS propagation (up to 24 hours)
6. Firebase automatically provisions SSL certificate

## 🧪 Testing

### Local Testing with Emulators

```bash
# Start Firebase emulators
firebase emulators:start

# In another terminal, run dev server
npm run dev
```

## 📚 Next Steps

This is **Phase 1 Complete** - Authentication & Roles foundation is set up.

**Coming in future phases:**
- Phase 2: Employee time entry interface
- Phase 3: Manager/Admin dashboards
- Phase 4: Reporting & CSV export
- Phase 5: Testing & deployment

## 🆘 Troubleshooting

**Login fails with "User not found"**
- Ensure user exists in both Authentication AND Firestore `users` collection
- Check that UIDs match exactly

**Permission denied errors**
- Verify Firestore rules are deployed: `firebase deploy --only firestore:rules`
- Check user's `active` field is `true`
- Confirm user's `role` field is set correctly

**Build errors**
- Delete `node_modules` and `package-lock.json`
- Run `npm install` again
- Check Node.js version (v18+)

## 📄 License

Internal use only - Not for public distribution

---

**Status:** Phase 1 Complete ✅
