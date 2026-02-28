import { useState, useEffect } from 'react';
import { authService, User } from './lib/auth';
import { dbService } from './lib/database';
import { LoginPage } from './components/LoginPage';
import { TodayEntry } from './components/employee/TodayEntry';
import { HistoryView } from './components/employee/HistoryView';
import { TeamDashboard } from './components/manager/TeamDashboard';
import { AdminPanel } from './components/admin/AdminPanel';
import { PayrollReports } from './components/admin/PayrollReports';
import { AuditViewer } from './components/admin/AuditViewer';
import { PatternMetrics } from './components/admin/PatternMetrics';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Badge } from './components/ui/badge';
import { UserAvatar } from './components/ui/user-avatar';
import { Toaster } from './components/ui/sonner';
import { LogOut, Clock, Users, Settings, FileText, Search, TrendingUp } from 'lucide-react';

type EmployeeView = 'today' | 'history';
type ManagerView = 'dashboard';
type AdminView = 'panel' | 'payroll' | 'audit' | 'metrics';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const testMode =
    import.meta.env.VITE_TEST_MODE === 'true' ||
    (import.meta.env.DEV && new URLSearchParams(window.location.search).has('test'));
  const usingEmulators =
    import.meta.env.VITE_USE_EMULATORS === 'true' ||
    (import.meta.env.DEV && new URLSearchParams(window.location.search).has('emu'));

  // View state
  const [employeeView, setEmployeeView] = useState<EmployeeView>('today');
  const [adminView, setAdminView] = useState<AdminView>('panel');

  useEffect(() => {
    const unsubscribe = authService.onAuthStateChanged((user) => {
      setCurrentUser(user);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadUsersIfAllowed() {
      if (!currentUser) {
        setAllUsers([]);
        return;
      }

      // Only managers/admins can list all users (Firestore rules enforce this too).
      if (currentUser.role === 'manager' || currentUser.role === 'admin') {
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
  }, [currentUser?.uid, currentUser?.role]);

  const handleLogout = async () => {
    await authService.logout();
    setEmployeeView('today');
    setAdminView('panel');
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
        <LoginPage onLoginSuccess={() => {}} />
        <Toaster />
      </>
    );
  }

  const renderHeader = () => (
    <header className="bg-card border-b border-border shadow-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 md:py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 md:gap-3">
            <div className="bg-primary p-2 md:p-2.5 rounded-lg">
              <Clock className="size-5 md:size-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-bold text-foreground text-base md:text-lg">TimeTracker</h1>
              <p className="text-xs md:text-sm text-muted-foreground hidden sm:block">Welcome back!</p>
            </div>
            {(testMode || usingEmulators) && (
              <div className="hidden sm:flex items-center gap-2 ml-2">
                {usingEmulators && <Badge variant="outline">EMULATORS</Badge>}
                {testMode && <Badge variant="secondary">TEST MODE</Badge>}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            <div className="hidden sm:flex items-center gap-3">
              <div className="text-right">
                <p className="text-sm font-medium text-foreground">{currentUser.name}</p>
                <p className="text-xs text-muted-foreground">
                  {currentUser.role === 'employee' ? `Employee #${currentUser.uid.padStart(4, '0')}` : currentUser.role}
                </p>
              </div>
              <UserAvatar name={currentUser.name} size="md" />
            </div>
            {/* Mobile Avatar Only */}
            <div className="sm:hidden">
              <UserAvatar name={currentUser.name} size="sm" />
            </div>
            <Button 
              variant="outline" 
              onClick={handleLogout}
              size="sm"
              className="h-8 md:h-10"
            >
              <LogOut className="size-4" />
              <span className="hidden md:inline ml-2">Sign Out</span>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );

  const renderEmployeeView = () => (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {employeeView === 'today' ? (
        <div className="max-w-4xl mx-auto">
          <TodayEntry
            user={currentUser}
            onViewHistory={() => setEmployeeView('history')}
          />
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
          {employeeView === 'today' ? (
            <TodayEntry
              user={currentUser}
              onViewHistory={() => setEmployeeView('history')}
            />
          ) : (
            <HistoryView
              user={currentUser}
              onBack={() => setEmployeeView('today')}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );

  const renderAdminView = () => (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <Tabs value={adminView} onValueChange={(v) => setAdminView(v as AdminView)} className="space-y-4">
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsList className="grid grid-cols-3 sm:grid-cols-5 w-full gap-1">
            <TabsTrigger value="panel" className="text-xs sm:text-sm">
              <Settings className="size-4 mr-0 sm:mr-2" />
              <span className="hidden sm:inline">Admin</span>
              <span className="sm:hidden">Panel</span>
            </TabsTrigger>
            <TabsTrigger value="payroll" className="text-xs sm:text-sm">
              <FileText className="size-4 mr-0 sm:mr-2" />
              <span className="hidden sm:inline">Payroll</span>
              <span className="sm:hidden">Pay</span>
            </TabsTrigger>
            <TabsTrigger value="audit" className="text-xs sm:text-sm">
              <Search className="size-4 mr-0 sm:mr-2" />
              <span>Audit</span>
            </TabsTrigger>
            <TabsTrigger value="metrics" className="text-xs sm:text-sm">
              <TrendingUp className="size-4 mr-0 sm:mr-2" />
              <span className="hidden sm:inline">Metrics</span>
              <span className="sm:hidden">Stats</span>
            </TabsTrigger>
            <TabsTrigger value="team" className="text-xs sm:text-sm">
              <Users className="size-4 mr-0 sm:mr-2" />
              <span>Team</span>
            </TabsTrigger>
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
          <PayrollReports allUsers={allUsers} />
        </TabsContent>

        <TabsContent value="audit">
          <AuditViewer allUsers={allUsers} />
        </TabsContent>

        <TabsContent value="metrics">
          <PatternMetrics allUsers={allUsers} />
        </TabsContent>

        <TabsContent value="team">
          <TeamDashboard user={currentUser} allUsers={allUsers} />
        </TabsContent>
      </Tabs>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      {renderHeader()}
      
      {currentUser.role === 'employee' && renderEmployeeView()}
      {currentUser.role === 'manager' && renderManagerView()}
      {currentUser.role === 'admin' && renderAdminView()}

      <Toaster />
    </div>
  );
}