# 🌐 CUSTOM DOMAIN SETUP GUIDE

## Setup: time.americantiledepot.com

This will make your TimeTrack system accessible at a professional subdomain!

---

## 📋 **STEP-BY-STEP INSTRUCTIONS:**

### **Step 1: GoDaddy DNS Setup** (5 mins)

1. **Login to GoDaddy:**
   - Go to: https://godaddy.com
   - Login with your credentials

2. **Go to DNS Management:**
   - Find "My Products"
   - Click on `americantiledepot.com`
   - Click "DNS" or "Manage DNS"

3. **Add CNAME Record:**
   - Click "Add" or "Add Record"
   - **Type:** CNAME
   - **Name/Host:** `time`
   - **Value/Points to:** `atd-time-tracking.web.app.`
   - **TTL:** 1 hour (or default)
   - Click "Save"

**Result:** This creates `time.americantiledepot.com` pointing to Firebase

---

### **Step 2: Firebase Console Setup** (3 mins)

1. **Open Firebase Console:**
   - Go to: https://console.firebase.google.com/project/atd-time-tracking/hosting
   - Click "Add custom domain"

2. **Add Domain:**
   - Enter: `time.americantiledepot.com`
   - Click "Continue"

3. **Verify Ownership:**
   - Firebase will show a TXT record
   - Copy the TXT record
   - Go back to GoDaddy DNS
   - Add TXT record (Firebase will give you the exact values)
   - Click "Save" in GoDaddy
   - Click "Verify" in Firebase

4. **Wait for SSL:**
   - Firebase will automatically provision SSL certificate
   - This takes 5-15 minutes
   - You'll get a green checkmark when ready

---

### **Step 3: Update Firebase Auth Domain** (2 mins)

1. **Open Firebase Console:**
   - Go to: https://console.firebase.google.com/project/atd-time-tracking/authentication/settings

2. **Add Authorized Domain:**
   - Scroll to "Authorized domains"
   - Click "Add domain"
   - Enter: `time.americantiledepot.com`
   - Click "Add"

**Result:** Login will work on your custom domain!

---

## ⏱️ **TIMELINE:**

- **DNS Propagation:** 5-60 minutes
- **SSL Certificate:** 5-15 minutes
- **Total:** ~30 minutes to fully working

---

## ✅ **AFTER SETUP:**

Your TimeTrack will be available at:
**https://time.americantiledepot.com**

**Benefits:**
- ✅ Professional branded URL
- ✅ Easier for employees to remember
- ✅ SSL certificate (https)
- ✅ May fix the module loading issues

---

## 🔍 **HOW TO CHECK IF IT'S WORKING:**

1. **Check DNS:**
   ```bash
   nslookup time.americantiledepot.com
   ```
   Should show Firebase IP addresses

2. **Check Domain:**
   - Go to: https://time.americantiledepot.com
   - Should show TimeTrack login page

3. **Check SSL:**
   - Look for padlock icon in browser
   - Should say "Secure"

---

## 🚨 **ALTERNATIVE: Skip Custom Domain**

If you want to skip the custom domain setup and just fix the current issue, we can:

**Option A:** Use localhost for testing
- Run: `npm run dev`
- Access at: `http://localhost:5173`
- This will definitely work!

**Option B:** Debug the production build
- The error is in how Vite is bundling
- I can fix the build configuration
- But custom domain is cleaner!

---

## 💡 **MY RECOMMENDATION:**

**Do BOTH:**

1. **Right now:** Test on localhost to verify everything works
   ```bash
   npm run dev
   ```
   Then go to: `http://localhost:5173`

2. **Tomorrow:** Set up custom domain properly
   - Gives you time to get GoDaddy login
   - Wait for DNS to propagate
   - More professional final solution

---

## 🎯 **IMMEDIATE NEXT STEP:**

**Let's test on localhost RIGHT NOW to prove the app works!**

Run this command:
```bash
npm run dev
```

Then open: `http://localhost:5173`

**Login should work perfectly there!**

Would you like to:
- **A)** Test on localhost first (proves it works)
- **B)** Set up custom domain now (more professional)
- **C)** I'll fix the Vite build issue (technical)

**What would you prefer?** 🚀
