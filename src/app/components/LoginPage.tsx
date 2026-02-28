import { useState } from 'react';
import { authService } from '../lib/auth';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { toast } from 'sonner';
import { Clock } from 'lucide-react';

interface LoginPageProps {
  onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      await authService.login(email, password);
      toast.success('Login successful!');
      onLoginSuccess();
    } catch (error) {
      const msg =
        error instanceof Error && error.message
          ? error.message
          : 'Login failed. Check your email/password.';
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
      setResetMode(false);
    } catch (error) {
      toast.error('Failed to send reset email');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md shadow-lg border-2">
        <CardHeader className="space-y-4 pb-6">
          <div className="flex items-center justify-center">
            <div className="bg-primary p-3 md:p-4 rounded-xl">
              <Clock className="size-8 md:size-10 text-primary-foreground" />
            </div>
          </div>
          <CardTitle className="text-center text-2xl">
            {resetMode ? 'Reset Password' : 'TimeTracker'}
          </CardTitle>
          <CardDescription className="text-center text-base">
            {resetMode 
              ? 'Enter your email to receive a password reset link'
              : 'Track your hours with ease'
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={resetMode ? handleResetPassword : handleLogin}>
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-base">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="h-12 text-base"
                />
              </div>
              {!resetMode && (
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-base">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="h-12 text-base"
                  />
                </div>
              )}
              <Button 
                type="submit" 
                className="w-full h-12 text-base bg-blue-600 hover:bg-blue-700" 
                disabled={loading}
              >
                {loading ? 'Loading...' : resetMode ? 'Send Reset Link' : 'Sign In'}
              </Button>
              <Button
                type="button"
                variant="link"
                className="w-full text-base"
                onClick={() => setResetMode(!resetMode)}
              >
                {resetMode ? 'Back to sign in' : 'Forgot password?'}
              </Button>
            </div>
          </form>

          <div className="mt-6 p-4 bg-slate-50 rounded-xl space-y-2 border border-slate-200">
            <p className="text-sm font-semibold text-slate-900">Test Accounts (local emulators):</p>
            <div className="space-y-1.5 text-sm">
              <p className="text-slate-700">Employee: employee@test.local</p>
              <p className="text-slate-700">Manager: manager@test.local</p>
              <p className="text-slate-700">Admin: admin@test.local</p>
              <p className="text-slate-600 mt-2 text-xs">Password: Test123!</p>
              <p className="text-slate-600 text-xs">Use `?emu` in the URL and run `npm run seed:test-users` after starting emulators.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}