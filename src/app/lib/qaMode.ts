/**
 * QA Mode
 *
 * Lets reviewers/QA testers impersonate any user + role + date without
 * touching real accounts. Enabled by adding `?qa=1` to the URL (dev) or by
 * setting `VITE_TEST_MODE=true` at build time (prod).
 *
 * Features:
 *  - Switch active "currentUser" between seeded test users (employee / manager / admin)
 *  - Override the "today" date so reviewers can look at any historical day
 *  - In-memory only — no Firestore writes from this module
 *
 * Safety:
 *  - The QA flag is honored ONLY if testMode is also enabled (see `isQAModeEnabled`).
 *  - The "real" auth flow still runs — QA mode is a layered override on top, not a
 *    replacement. This way, a deployed production build with VITE_TEST_MODE=true
 *    can still be locked down by removing that env var.
 */

export interface QAUserOverride {
    uid: string;
    name: string;
    email: string;
    role: 'employee' | 'manager' | 'admin';
    active: boolean;
    timezone: string;
}

export interface QAState {
    enabled: boolean;
    /** When set, overrides the currentUser from auth. */
    impersonate: QAUserOverride | null;
    /** When set, overrides the YYYY-MM-DD "today" used by employee views. */
    dateOverride: string | null;
}

const STORAGE_KEY = 'timetrack:qa-state:v1';

const SEED_USERS: QAUserOverride[] = [
    {
        uid: 'qa-emp',
        name: 'QA Employee',
        email: 'qa-employee@test.local',
        role: 'employee',
        active: true,
        timezone: 'America/Los_Angeles',
    },
    {
        uid: 'qa-mgr',
        name: 'QA Manager',
        email: 'qa-manager@test.local',
        role: 'manager',
        active: true,
        timezone: 'America/Los_Angeles',
    },
    {
        uid: 'qa-adm',
        name: 'QA Admin',
        email: 'qa-admin@test.local',
        role: 'admin',
        active: true,
        timezone: 'America/Los_Angeles',
    },
];

function envFlag(name: string, paramName: string): boolean {
    if (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string | undefined> }).env?.[name] === 'true') return true;
    if (typeof window !== 'undefined') {
        return new URLSearchParams(window.location.search).get(paramName) === '1';
    }
    return false;
}

/** True if the app was built or launched in test mode. */
export function isTestMode(): boolean {
    return envFlag('VITE_TEST_MODE', 'test');
}

/** True if QA mode UI should be available right now. */
export function isQAModeEnabled(): boolean {
    return isTestMode() || envFlag('VITE_QA_MODE', 'qa');
}

/** The canned set of users available for impersonation. */
export function getQASeedUsers(): QAUserOverride[] {
    return SEED_USERS;
}

function readStorage(): QAState {
    if (typeof window === 'undefined') return { enabled: false, impersonate: null, dateOverride: null };
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return { enabled: false, impersonate: null, dateOverride: null };
        const parsed = JSON.parse(raw);
        return {
            enabled: !!parsed.enabled,
            impersonate: parsed.impersonate || null,
            dateOverride: parsed.dateOverride || null,
        };
    } catch {
        return { enabled: false, impersonate: null, dateOverride: null };
    }
}

function writeStorage(s: QAState) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        // Fire a custom event so other components can react without prop drilling
        window.dispatchEvent(new CustomEvent('tt:qa-state-changed', { detail: s }));
    } catch {
        // localStorage may be unavailable (private mode, quota); silently ignore
    }
}

export function loadQAState(): QAState {
    return readStorage();
}

export function setQAEnabled(enabled: boolean) {
    const s = readStorage();
    writeStorage({ ...s, enabled });
}

export function setQAImpersonate(user: QAUserOverride | null) {
    const s = readStorage();
    writeStorage({ ...s, impersonate: user });
}

export function setQADateOverride(date: string | null) {
    const s = readStorage();
    writeStorage({ ...s, dateOverride: date });
}

export function clearQAState() {
    if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new CustomEvent('tt:qa-state-changed', { detail: { enabled: false, impersonate: null, dateOverride: null } }));
}

/** Resolves the effective "today" YYYY-MM-DD string, honoring QA override. */
export function effectiveTodayYmd(override: string | null): string {
    if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}
