import { useState } from 'react';
import { authService } from '../lib/auth';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { toast } from 'sonner';
import { Clock, Eye, EyeOff } from 'lucide-react';

interface LoginPageProps {
  onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'login' | 'register' | 'reset'>('login');
  const [showPassword, setShowPassword] = useState(false);

  const handleGoogleLogin = async () => {
    try {
      setLoading(true);
      await authService.loginWithGoogle();
      toast.success('Logged in with Google!');
      onLoginSuccess();
    } catch (error: any) {
      toast.error(error.message || 'Failed to log in with Google');
      setLoading(false);
    }
  };

  const handleAuthAction = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (view === 'login') {
        await authService.login(email, password);
        toast.success('Login successful!');
      } else if (view === 'register') {
        if (!name) {
          toast.error('Please enter your full name');
          setLoading(false);
          return;
        }
        await authService.register(name, email, password);
        toast.success('Account created successfully!');
      }
      onLoginSuccess();
    } catch (error) {
      // Provide user-friendly error messages based on common Firebase auth codes
      let msg = 'Authentication failed. Please check your details.';
      const err = error as any;

      if (err.code === 'auth/invalid-credential' || err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') {
        msg = 'Invalid email or password.';
      } else if (err.code === 'auth/too-many-requests') {
        msg = 'Too many failed login attempts. Please try again later.';
      } else if (err.message && err.message !== 'Account inactive') {
        // Use the raw message if it's not a standard firebase code and not our custom 'Account inactive'
        msg = err.message.replace('Firebase: ', '').split(' (auth/')[0];
      } else if (err.message === 'Account inactive') {
        msg = 'Your account has been deactivated. Please contact an administrator.';
      }

      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast.error('Please enter your email address');
      return;
    }

    setLoading(true);
    try {
      await authService.sendPasswordResetEmail(email);
      toast.success('Password reset email sent!');
      setView('login');
    } catch (error) {
      toast.error('Failed to send reset email');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-violet-50 p-4 font-sans relative overflow-hidden">
      {/* Decorative background blobs */}
      <div className="absolute top-[-10%] left-[-10%] w-[40rem] h-[40rem] rounded-full bg-indigo-300/20 blur-3xl mix-blend-multiply opacity-70 animate-blob"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40rem] h-[40rem] rounded-full bg-violet-300/20 blur-3xl mix-blend-multiply opacity-70 animate-blob animation-delay-2000"></div>

      <div className="w-full max-w-md z-10 space-y-6">
        <Card className="shadow-2xl border border-white/40 bg-white/60 backdrop-blur-xl">
          <CardHeader className="space-y-4 pb-6 pt-8">
            <div className="flex items-center justify-center">
              <div className="bg-gradient-to-tr from-indigo-600 to-violet-500 p-4 rounded-full shadow-lg shadow-indigo-500/30">
                <Clock className="size-8 text-white" />
              </div>
            </div>
            <div className="space-y-2 text-center">
              <CardTitle className="text-3xl font-bold tracking-tight text-slate-900">
                {view === 'reset' ? 'Reset Password' : view === 'register' ? 'Create Account' : 'TimeTracker'}
              </CardTitle>
              <CardDescription className="text-base text-slate-500">
                {view === 'reset'
                  ? 'Enter your email to receive a password reset link'
                  : view === 'register'
                    ? 'Sign up to start tracking your hours'
                    : 'Track your hours with style and ease'
                }
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pb-8 px-8">
            <form onSubmit={view === 'reset' ? handleResetPassword : handleAuthAction}>
              <div className="space-y-5">
                {view === 'register' && (
                  <div className="space-y-2">
                    <Label htmlFor="name" className="text-sm font-semibold text-slate-700">Full Name</Label>
                    <Input
                      id="name"
                      type="text"
                      placeholder="Jane Doe"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      className="h-12 text-base bg-white/50 border-slate-200 focus:border-indigo-500 focus:ring-indigo-500 transition-all rounded-xl shadow-sm"
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-sm font-semibold text-slate-700">Email Address</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="h-12 text-base bg-white/50 border-slate-200 focus:border-indigo-500 focus:ring-indigo-500 transition-all rounded-xl shadow-sm"
                  />
                </div>
                {view !== 'reset' && (
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <Label htmlFor="password" className="text-sm font-semibold text-slate-700">Password</Label>
                      {view === 'login' && (
                        <button
                          type="button"
                          onClick={() => setView('reset')}
                          className="text-sm font-medium text-indigo-600 hover:text-indigo-500 transition-colors"
                        >
                          Forgot password?
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        className="h-12 text-base bg-white/50 border-slate-200 focus:border-indigo-500 focus:ring-indigo-500 transition-all rounded-xl shadow-sm pr-12"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none transition-colors"
                      >
                        {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                      </button>
                    </div>
                  </div>
                )}
                <Button
                  type="submit"
                  className="w-full h-12 text-base font-semibold bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white rounded-xl shadow-md hover:shadow-lg transition-all transform active:scale-[0.98]"
                  disabled={loading}
                >
                  {loading ? 'Loading...' : view === 'reset' ? 'Send Reset Link' : view === 'register' ? 'Sign Up' : 'Sign In'}
                </Button>

                {view === 'login' && (
                  <div className="space-y-4 pt-2">
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t border-slate-200" />
                      </div>
                      <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-transparent px-2 text-slate-500 font-medium relative top-[-1px]">Or continue with</span>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleGoogleLogin}
                      disabled={loading}
                      className="w-full h-12 text-base font-medium bg-white hover:bg-slate-50 border-slate-200 text-slate-700 rounded-xl shadow-sm hover:shadow-md transition-all flex items-center justify-center gap-2"
                    >
                      <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <path
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                          fill="#4285F4"
                        />
                        <path
                          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                          fill="#34A853"
                        />
                        <path
                          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                          fill="#FBBC05"
                        />
                        <path
                          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                          fill="#EA4335"
                        />
                        <path d="M1 1h22v22H1z" fill="none" />
                      </svg>
                      Google
                    </Button>
                  </div>
                )}

                <div className="text-center pt-2">
                  {view === 'login' ? (
                    <p className="text-sm text-slate-600">
                      Don't have an account?{' '}
                      <button
                        type="button"
                        onClick={() => setView('register')}
                        className="font-medium text-indigo-600 hover:text-indigo-500"
                      >
                        Sign up
                      </button>
                    </p>
                  ) : (
                    <button
                      type="button"
                      className="text-sm font-medium text-slate-600 hover:text-slate-900"
                      onClick={() => setView('login')}
                    >
                      Back to sign in
                    </button>
                  )}
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}