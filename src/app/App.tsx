import { useState, useEffect, useRef, useCallback } from 'react';
import { authService, User } from './lib/auth';
import { dbService } from './lib/database';
import { LoginPage } from './components/LoginPage';
import { TodayEntry } from './components/employee/TodayEntry';
import { ClockPunch } from './components/employee/ClockPunch';
import { HistoryView } from './components/employee/HistoryView';
import { TeamDashboard } from './components/manager/TeamDashboard';
import { AdminPanel } from './components/admin/AdminPanel';
import { PayrollReports } from './components/admin/PayrollReports';
import { AnalyticsReport } from './components/admin/AnalyticsReport';
import { AuditViewer } from './components/admin/AuditViewer';
import { PatternMetrics } from './components/admin/PatternMetrics';
import { CorrectionRequests } from './components/admin/CorrectionRequests';
import { SystemSettingsView, type SettingsGuard } from './components/admin/SystemSettingsView';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { UserAvatar } from './components/ui/user-avatar';
import { TimeZoneSelector } from './components/ui/time-zone-selector';
import { TimezoneViewToggle } from './components/ui/timezone-view-toggle';
import type { TimeViewMode } from '../utils/timeView';
import { DEFAULT_DISPLAY_TIMEZONE, AUTO_TIMEZONE, timezoneToPersist } from './lib/timezones';
import { Save, RotateCcw, ArrowLeft } from 'lucide-react';

/** localStorage key for the persisted display-timezone choice ('auto' or IANA id). */
const DISPLAY_TIMEZONE_STORAGE_KEY = 'timetrack.displayTimezone';
/** Per-user localStorage key for an admin's preferred view ('admin' | 'employee'). */
const adminViewModeStorageKey = (uid: string) => `timetrack.adminViewMode.${uid}`;
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { Toaster } from './components/ui/sonner';
import { toast } from 'sonner';
import { LogOut, Clock, Users, Settings, FileText, FileWarning, Sliders, Shield, BarChart } from 'lucide-react';
import { QABar } from './components/QABar';
import { ReportProblemButton } from './components/ReportProblemButton';

type EmployeeView = 'today' | 'history';
type AdminView = 'panel' | 'payroll' | 'analytics' | 'audit' | 'metrics' | 'team' | 'corrections' | 'settings';

/** All valid admin tab ids — used to validate the ?tab= deep-link param. */
const ADMIN_TAB_VALUES: readonly AdminView[] = ['panel', 'payroll', 'analytics', 'audit', 'metrics', 'team', 'corrections', 'settings'];

/** Read the deep-linked admin tab from the URL (?tab=payroll), or null. */
function adminTabFromLocation(): AdminView | null {
  try {
    const t = new URLSearchParams(window.location.search).get('tab');
    return ADMIN_TAB_VALUES.includes(t as AdminView) ? (t as AdminView) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  // Header time zone selector value. Either the 'auto' sentinel (tracks the
  // OS timezone, the default) or a concrete IANA id (manual override). The
  // selector is the employee's control over their `user.timezone`: changing it
  // persists the resolved IANA zone to Firestore, which drives entry doc ids,
  // the local-midnight split, week boundaries, and per-local-date totals.
  const [displayTimezone, setDisplayTimezoneState] = useState<string>(
    () => localStorage.getItem(DISPLAY_TIMEZONE_STORAGE_KEY) || DEFAULT_DISPLAY_TIMEZONE,
  );
  // Admin-only view switcher: 'employee' renders the regular employee surface
  // (ClockPunch/TodayEntry fed with the admin's own user object) so admins can
  // clock in/out like a regular employee. Persisted per-uid in localStorage so
  // the choice survives page refresh. Employees/managers never see this.
  const [adminViewMode, setAdminViewModeState] = useState<'admin' | 'employee'>('admin');

  // Persist the resolved concrete IANA zone to the employee's profile and
  // update the active app context immediately so clockService / shift
  // splitting / doc id creation / history pick up the new zone without a
  // reload. `selectorValue` is the raw selector value ('auto' or an IANA id).
  const syncTimezoneToProfile = useCallback(
    async (selectorValue: string, opts?: { silent?: boolean }) => {
      if (!currentUser) return;
      // The header selector drives profile tz for employees — and for admins
      // while they are in Employee View (where they punch under their own uid).
      // An admin in Admin View keeps the old behavior: tz managed via AdminPanel.
      if (currentUser.role === 'admin' && adminViewMode !== 'employee') return;
      const zone = timezoneToPersist(selectorValue, currentUser.timezone);
      if (!zone) return; // already in sync — no write needed
      // Optimistic context update so downstream consumers re-derive
      // immediately; revert on failure.
      const prevTz = currentUser.timezone;
      setCurrentUser((prev) => (prev ? { ...prev, timezone: zone } : prev));
      setAllUsers((prev) =>
        prev.map((u) => (u.uid === currentUser.uid ? { ...u, timezone: zone } : u)),
      );
      try {
        await dbService.updateUser(currentUser.uid, { timezone: zone });
        if (!opts?.silent) {
          toast.success(`Time zone updated to ${zone}`);
        }
      } catch (e: unknown) {
        // Revert the optimistic update; the selector's display value still
        // reflects the choice, but calculations stay on the stored zone until
        // the write succeeds.
        setCurrentUser((prev) => (prev ? { ...prev, timezone: prevTz } : prev));
        setAllUsers((prev) =>
          prev.map((u) => (u.uid === currentUser.uid ? { ...u, timezone: prevTz } : u)),
        );
        if (opts?.silent) {
          // Auto-sync on load: permission errors (e.g. legacy docs not yet
          // matching the self-service rule) or transient network failures must
          // not spam an error toast on every page load. Log instead.
          console.warn('Could not auto-sync time zone to profile:', e);
        } else {
          toast.error('Could not save time zone: ' + ((e as Error).message || String(e)));
        }
      }
    },
    [currentUser, adminViewMode],
  );

  const setDisplayTimezone = (tz: string) => {
    setDisplayTimezoneState(tz);
    try {
      localStorage.setItem(DISPLAY_TIMEZONE_STORAGE_KEY, tz);
    } catch {
      // localStorage may be unavailable (private mode / quota); the in-memory
      // choice still works for the session.
    }
    // Persist the resolved zone to the employee's profile (manual selection).
    void syncTimezoneToProfile(tz);
  };

  // Auto-detection sync: on load, when "Auto" is selected and the detected OS
  // time zone differs from the stored `user.timezone`, sync the profile so the
  // employee's calculations follow their device (e.g. after traveling). Silent
  // — no toast on the common load path.
  useEffect(() => {
    // Applies to employees, and to admins while they are in Employee View
    // (where their own punches depend on user.timezone like any employee).
    if (!currentUser || (currentUser.role === 'admin' && adminViewMode !== 'employee')) return;
    if (displayTimezone !== AUTO_TIMEZONE) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void syncTimezoneToProfile(AUTO_TIMEZONE, { silent: true });
  }, [currentUser, adminViewMode, displayTimezone, syncTimezoneToProfile]);

  const testMode =
    import.meta.env.VITE_TEST_MODE === 'true' ||
    (import.meta.env.DEV && new URLSearchParams(window.location.search).has('test'));
  const usingEmulators =
    import.meta.env.VITE_USE_EMULATORS === 'true' ||
    (import.meta.env.DEV && new URLSearchParams(window.location.search).has('emu'));
  // Audit fix: previously both `ClockPunch` (new, one-tap) and `TodayEntry`
  // (legacy, multi-step form) rendered stacked for every employee. Two
  // competing UIs caused inconsistent behaviour across users. Now ClockPunch
  // is the primary employee surface; TodayEntry is opt-in via ?classic=1 so
  // pilot users can fall back if needed.
  const useClassicEntry = new URLSearchParams(window.location.search).get('classic') === '1';

  // View state
  const [employeeView, setEmployeeView] = useState<EmployeeView>('today');
  // Initial tab honors the ?tab= deep link (supports 'open in new tab').
  const [adminView, setAdminView] = useState<AdminView>(() => adminTabFromLocation() ?? 'panel');
  // Admin/Manager timezone view (Req 4): 'local' = employee local tz (default),
  // 'pt' = America/Los_Angeles (California Time). Applied to analysis views.
  const [timeViewMode, setTimeViewMode] = useState<TimeViewMode>('local');

  // Unsaved-changes navigation guard for the Settings tab.
  // settingsGuardRef lets SystemSettingsView expose its dirty state +
  // save/discard/highlight handlers to us without prop-drilling.
  // pendingTab holds the admin tab the user tried to switch to while dirty;
  // when set, the Unsaved Changes modal is shown.
  const settingsGuardRef = useRef<SettingsGuard>(null);
  const [pendingTab, setPendingTab] = useState<AdminView | null>(null);

  /**
   * Tab navigation with URL sync: every switch pushState()s ?tab=<id> so the
   * browser back/forward buttons and copied links land on the same tab, and
   * anchor-rendered tabs offer native 'open in new tab' context menus.
   */
  const navigateToAdminTab = useCallback((next: AdminView) => {
    setAdminView(next);
    try {
      const url = next === 'panel'
        ? window.location.pathname
        : window.location.pathname + '?tab=' + next;
      window.history.pushState(null, '', url);
    } catch {
      // history API unavailable — in-memory state still switches.
    }
  }, []);

  /**
   * Guarded tab switch — the single navigation path for every in-app admin
   * tab change (nav bar AND the Settings → Deprecated tabs shortcut).
   * Intercepts switches away from a dirty Settings form so the Unsaved
   * Changes modal can offer save/discard before navigating.
   */
  const requestAdminTab = useCallback((next: AdminView) => {
    if (adminView === 'settings' && next !== 'settings' && settingsGuardRef.current?.isDirty()) {
      setPendingTab(next);
      return;
    }
    navigateToAdminTab(next);
  }, [adminView, navigateToAdminTab]);

  // Back/forward buttons: re-read ?tab= and follow it.
  useEffect(() => {
    const onPop = () => {
      // A bare pathname (no ?tab=) means the Panel tab — navigateToAdminTab
      // deliberately strips the param for it, so default to 'panel' here or
      // Back past the last ?tab= entry would leave the view desynced.
      const t = adminTabFromLocation() ?? 'panel';
      setAdminView(t);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [guardBusy, setGuardBusy] = useState(false);

  // Browser unload guard: if the Settings form is dirty, prompt before the
  // page is closed/refreshed. beforeunload requires a string return (ignored
  // by modern browsers but necessary to trigger the native prompt).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (settingsGuardRef.current?.isDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = authService.onAuthStateChanged((user) => {
      // Restore the admin's persisted view preference in the same batch as the
      // user state so a refresh renders the remembered view with no flash.
      if (user?.role === 'admin') {
        try {
          const stored = localStorage.getItem(adminViewModeStorageKey(user.uid));
          setAdminViewModeState(stored === 'employee' ? 'employee' : 'admin');
        } catch {
          setAdminViewModeState('admin');
        }
      } else {
        setAdminViewModeState('admin');
      }
      setCurrentUser(user);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const setAdminViewMode = (mode: 'admin' | 'employee') => {
    setAdminViewModeState(mode);
    if (currentUser?.uid) {
      try {
        localStorage.setItem(adminViewModeStorageKey(currentUser.uid), mode);
      } catch {
        // localStorage unavailable (private mode / quota) — in-memory only.
      }
    }
  };

  // Depend on uid/role primitives (not the user object identity) so this only
  // re-runs when the signed-in user or their role actually changes.
  const currentUserUid = currentUser?.uid;
  const currentUserRole = currentUser?.role;

  useEffect(() => {
    let cancelled = false;

    async function loadUsersIfAllowed() {
      if (!currentUserUid) {
        setAllUsers([]);
        return;
      }

      // Only managers/admins can list all users (Firestore rules enforce this too).
      if (currentUserRole === 'manager' || currentUserRole === 'admin') {
        try {
          const users = await dbService.getAllUsers();
          if (!cancelled) setAllUsers(users);
        } catch {
          if (!cancelled) setAllUsers([]);
        }
      } else {
        setAllUsers([]);
      }
    }

    loadUsersIfAllowed();
    return () => {
      cancelled = true;
    };
  }, [currentUserUid, currentUserRole]);

  const handleLogout = async () => {
    if (currentUser?.uid) {
      try {
        localStorage.removeItem(adminViewModeStorageKey(currentUser.uid));
      } catch {
        // Ignore — storage may be unavailable.
      }
    }
    await authService.logout();
    setEmployeeView('today');
    setAdminView('panel');
    setAdminViewModeState('admin');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Loading...</p>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <>
        <LoginPage onLoginSuccess={() => { }} />
        <Toaster />
      </>
    );
  }

  const renderHeader = () => (
    <header className="bg-white/70 backdrop-blur-xl border-b border-indigo-100/50 shadow-sm sticky top-0 z-50 py-3">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 md:gap-3">
            <div className="bg-gradient-to-tr from-indigo-600 to-violet-500 p-2 md:p-2.5 rounded-xl shadow-md shadow-indigo-500/20">
              <Clock className="size-5 md:size-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-slate-900 text-base md:text-lg tracking-tight">TimeTracker</h1>
              <p className="text-xs md:text-sm text-slate-500 hidden sm:block font-medium">Welcome back!</p>
            </div>
            {(testMode || usingEmulators) && (
              <div className="hidden sm:flex items-center gap-2 ml-4">
                {usingEmulators && <Badge variant="outline" className="border-indigo-200 text-indigo-700 bg-indigo-50/50">EMULATORS</Badge>}
                {testMode && <Badge variant="secondary" className="bg-violet-100 text-violet-800">TEST MODE</Badge>}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            {(currentUser.role !== 'admin' || adminViewMode === 'employee') && (
              <TimeZoneSelector value={displayTimezone} onChange={setDisplayTimezone} />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account menu"
                className="rounded-full outline-none cursor-pointer transition-all duration-200 hover:brightness-90 focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                <UserAvatar
                  name={currentUser.name}
                  size="md"
                  className="size-8 sm:size-10"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={8} className="w-56 p-2">
                <div className="px-2 py-1.5">
                  <p className="text-sm font-bold text-slate-800 tracking-tight truncate">
                    {currentUser.name}
                  </p>
                  <p className="text-xs text-indigo-600 font-medium uppercase tracking-wider">
                    {currentUser.role === 'employee'
                      ? `Emp #${currentUser.uid.substring(0, 4)}`
                      : currentUser.role}
                  </p>
                </div>
                <DropdownMenuSeparator />
                {currentUser.role === 'admin' && (
                  <DropdownMenuItem
                    onSelect={() => setAdminViewMode(adminViewMode === 'admin' ? 'employee' : 'admin')}
                    className="cursor-pointer w-full justify-start gap-2 font-medium"
                  >
                    {adminViewMode === 'admin' ? (
                      <>
                        <Clock className="size-4" />
                        <span>Switch to Employee View</span>
                      </>
                    ) : (
                      <>
                        <Shield className="size-4" />
                        <span>Switch to Admin View</span>
                      </>
                    )}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => handleLogout()}
                  className="cursor-pointer w-full justify-start gap-2 font-medium"
                >
                  <LogOut className="size-4" />
                  <span>Sign Out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </header>
  );

  const renderEmployeeView = () => (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
      {employeeView === 'today' ? (
        <div className="max-w-4xl mx-auto space-y-6">
          {useClassicEntry ? (
            <TodayEntry
              user={currentUser}
              onViewHistory={() => setEmployeeView('history')}
            />
          ) : (
            <ClockPunch
              user={currentUser}
              onViewHistory={() => setEmployeeView('history')}
              displayTimezone={displayTimezone}
            />
          )}
        </div>
      ) : (
        <HistoryView
          user={currentUser}
          onBack={() => setEmployeeView('today')}
        />
      )}
    </div>
  );

  const renderManagerView = () => (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <Tabs defaultValue="team" className="space-y-6">
        <TabsList className="grid grid-cols-2 w-full">
          <TabsTrigger value="team">
            <Users className="size-4 mr-2" />
            Team
          </TabsTrigger>
          <TabsTrigger value="my-time">
            <Clock className="size-4 mr-2" />
            My Time
          </TabsTrigger>
        </TabsList>

        <TabsContent value="team">
          <TeamDashboard user={currentUser} allUsers={allUsers} />
        </TabsContent>

        <TabsContent value="my-time">
          {useClassicEntry ? (
            employeeView === 'today' ? (
              <TodayEntry
                user={currentUser}
                onViewHistory={() => setEmployeeView('history')}
              />
            ) : (
              <HistoryView
                user={currentUser}
                onBack={() => setEmployeeView('today')}
              />
            )
          ) : (
            <ClockPunch
              user={currentUser}
              onViewHistory={() => setEmployeeView('history')}
              displayTimezone={displayTimezone}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );

  const renderAdminView = () => (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <Tabs
        value={adminView}
        onValueChange={(v) => requestAdminTab(v as AdminView)}
        className="space-y-4"
      >
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          {/*
            Tabs render as real anchors (asChild) with href="?tab=<id>" so
            right-click / middle-click / ctrl+click get native browser link
            behavior ("Open link in new tab" etc.). Left-click preventDefault
            keeps the in-app Radix flow (including the unsaved-settings guard
            in onValueChange); Radix already ignores ctrl+click activation.
            Active-tab styling is unchanged (data-state lives on the anchor
            via the slotted trigger).
          */}
          <TabsList className="grid grid-cols-3 sm:grid-cols-5 w-full gap-1">
            {([
              { id: 'panel', icon: <Settings className="size-4 mr-0 sm:mr-2" />, full: 'User Base', short: 'User Base' },
              { id: 'payroll', icon: <FileText className="size-4 mr-0 sm:mr-2" />, full: 'Payroll', short: 'Pay' },
              { id: 'analytics', icon: <BarChart className="size-4 mr-0 sm:mr-2" />, full: 'Analytics', short: 'Analyt' },
              { id: 'corrections', icon: <FileWarning className="size-4 mr-0 sm:mr-2" />, full: 'Corrections', short: 'Fix' },
              { id: 'settings', icon: <Sliders className="size-4 mr-0 sm:mr-2" />, full: 'Settings', short: 'Set' },
            ] as { id: AdminView; icon: React.ReactNode; full: string; short: string }[]).map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} asChild className="text-xs sm:text-sm">
                <a
                  href={tab.id === 'panel' ? window.location.pathname : window.location.pathname + '?tab=' + tab.id}
                  onClick={(e) => e.preventDefault()}
                >
                  {tab.icon}
                  <span className="hidden sm:inline">{tab.full}</span>
                  <span className="sm:hidden">{tab.short}</span>
                </a>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="panel">
          <AdminPanel
            currentUser={currentUser}
            allUsers={allUsers}
            onUsersChange={setAllUsers}
          />
        </TabsContent>

        <TabsContent value="payroll">
          <PayrollReports allUsers={allUsers} timeViewMode={timeViewMode} onTimeViewChange={setTimeViewMode} />
        </TabsContent>

        <TabsContent value="analytics">
          <AnalyticsReport allUsers={allUsers} currentUser={currentUser} timeViewMode={timeViewMode} onTimeViewChange={setTimeViewMode} />
        </TabsContent>

        <TabsContent value="audit">
          <div className="mb-3">
            <TimezoneViewToggle mode={timeViewMode} onChange={setTimeViewMode} />
          </div>
          <AuditViewer allUsers={allUsers} timeViewMode={timeViewMode} />
        </TabsContent>

        <TabsContent value="metrics">
          <div className="mb-3">
            <TimezoneViewToggle mode={timeViewMode} onChange={setTimeViewMode} />
          </div>
          <PatternMetrics allUsers={allUsers} timeViewMode={timeViewMode} />
        </TabsContent>

        <TabsContent value="team">
          <div className="mb-3">
            <TimezoneViewToggle mode={timeViewMode} onChange={setTimeViewMode} />
          </div>
          <TeamDashboard user={currentUser} allUsers={allUsers} timeViewMode={timeViewMode} />
        </TabsContent>

        <TabsContent value="corrections">
          <CorrectionRequests currentUser={currentUser} />
        </TabsContent>

        <TabsContent value="settings">
          <SystemSettingsView
            ref={settingsGuardRef}
            currentUser={currentUser}
            onOpenAudit={() => requestAdminTab('audit')}
            onOpenTeam={() => requestAdminTab('team')}
            onOpenMetrics={() => requestAdminTab('metrics')}
          />
        </TabsContent>
      </Tabs>

      {/* Unsaved Changes navigation guard (Settings tab only). */}
      <Dialog open={pendingTab !== null} onOpenChange={(open) => { if (!open) setPendingTab(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              You have unsaved settings changes. What would you like to do before leaving?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-col gap-2 sm:flex-col sm:justify-stretch">
            <Button
              className="w-full"
              disabled={guardBusy}
              onClick={async () => {
                setGuardBusy(true);
                const ok = await settingsGuardRef.current?.save();
                setGuardBusy(false);
                if (ok) {
                  const next = pendingTab;
                  setPendingTab(null);
                  if (next) navigateToAdminTab(next);
                }
              }}
            >
              <Save className="size-4 mr-2" />
              Save settings
            </Button>
            <Button
              variant="outline"
              className="w-full"
              disabled={guardBusy}
              onClick={() => {
                settingsGuardRef.current?.discard();
                const next = pendingTab;
                setPendingTab(null);
                if (next) navigateToAdminTab(next);
              }}
            >
              <RotateCcw className="size-4 mr-2" />
              Discard changes
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                settingsGuardRef.current?.highlightDirty();
                setPendingTab(null);
              }}
            >
              <ArrowLeft className="size-4 mr-2" />
              Get back to the settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      {isOffline && (
        <div className="bg-amber-500 text-white text-center py-2 px-4 text-sm font-medium animate-in slide-in-from-top-2">
          You are currently offline. Time entries will be saved when your connection is restored.
        </div>
      )}
      {renderHeader()}
      {currentUser.role === 'admin' && adminViewMode === 'employee' && (
        <div className="bg-indigo-50/80 border-b border-indigo-100 text-indigo-800 text-center py-1.5 px-4 text-xs sm:text-sm font-medium">
          Admin Mode: Viewing as Employee
          <button
            type="button"
            onClick={() => setAdminViewMode('admin')}
            className="ml-2 underline underline-offset-2 hover:text-indigo-950 cursor-pointer"
          >
            Switch back to Admin View
          </button>
        </div>
      )}

      {currentUser.role === 'employee' && renderEmployeeView()}
      {currentUser.role === 'manager' && renderManagerView()}
      {currentUser.role === 'admin' && (adminViewMode === 'employee' ? renderEmployeeView() : renderAdminView())}

      <Toaster />
      <QABar />
      <ReportProblemButton />
    </div>
  );
}
