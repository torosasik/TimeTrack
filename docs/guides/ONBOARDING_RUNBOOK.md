## TimeTrack Onboarding Runbook (Admin/Manager)

### Canonical URL
- **App URL**: `https://time.americantiledepot.com`

### Create users (recommended flow)
Use **Admin Panel → Create New User**.

- **Bulk import (CSV)**: use **Admin Panel → Bulk Import**
  - You can start from `templates/users-import-template.csv` as a reference.

- **Recommended**: leave **“Send Invitation Email” checked**
  - User gets a password reset email to set their password.
  - Admin stays logged in (safe).
- **If you want to set an initial password yourself**: uncheck **“Send Invitation Email”**
  - Enter the password in the form.
  - Admin stays logged in (safe).

### Roles
- **Employee**: can submit their own time; can view their own history.
- **Manager**: can do everything an employee can, plus see Team Dashboard and (if enabled) audit/payroll tools.
- **Admin**: full access (users, corrections, audit, payroll, pattern metrics).

### What each role sees (UI walkthrough)
- **Common (all roles)**
  - **Login**: email + password.
  - **Header**: shows **your name + role** (example: `Maria Lopez (Employee)`) and **Sign Out**.

- **Employee**
  - **Default landing page**: the main app (`/`) which shows the employee time entry screen after login
  - **Flow**: a **4-step** “Sequential Time Entry” tracker:
    - **Step 1** Clock In → **Step 2** Lunch Out (or **Skip Lunch**) → **Step 3** Lunch In → **Step 4** Clock Out
    - After Step 4, the entry shows **✅ Time Entry Complete** and becomes **read-only**.
  - **History**: use the **View History** button in the app to see past entries.

- **Manager**
  - Everything employees have, plus **Team Dashboard** inside the app (manager role)
  - **Team Dashboard** includes:
    - Filters (Employee, Start/End date, Status)
    - Quick date buttons (Today/Yesterday/This Week/Last Week/This Month)
    - Actions: **Export CSV**, **Print**, **Refresh**
    - Click an entry to open **details modal** (review times + flags)

- **Admin**
  - Everything managers have, plus admin tools:
    - **💰 Payroll Reports**, **🔍 Audit Viewer**, **📊 Pattern Metrics**, **⚙️ Admin Panel**
  - **Admin Panel → Quick Actions**:
    - **Create New User**
    - **Bulk Import** (CSV)
    - **Manage Users** (search/filter)
    - **Correct Entry** (with required admin notes)

### Employee quick-start (send to employees)
1. Go to `https://time.americantiledepot.com`
2. Log in with your email + password (or set your password from the invitation email)
3. Open **My Time Entry**
4. Submit your day in order:
   - Clock In → Lunch Out → Lunch In → Clock Out → Complete
5. Use **History** to view past entries.

### Notes
- **First-day exception**: brand-new users (no prior entries) are not blocked by the “yesterday missing” rule on their first use.
- **Payroll report indexing**: if Payroll Reports shows “index building”, wait a few minutes and retry.


