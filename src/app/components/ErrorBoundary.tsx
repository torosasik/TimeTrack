import { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
    children?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo);
    }

    public render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
                    <Card className="w-full max-w-md border-2 border-red-200">
                        <CardHeader className="text-center pb-2">
                            <div className="mx-auto bg-red-100 w-12 h-12 rounded-full flex items-center justify-center mb-4">
                                <AlertTriangle className="size-6 text-red-600" />
                            </div>
                            <CardTitle className="text-xl text-red-700">Something went wrong</CardTitle>
                        </CardHeader>
                        <CardContent className="text-center space-y-4">
                            <p className="text-slate-600 text-sm">
                                An unexpected error occurred. Please try refreshing the page.
                            </p>
                            {this.state.error && (
                                <div className="bg-slate-100 p-3 rounded text-left overflow-auto max-h-32 text-xs font-mono text-slate-700 border border-slate-200">
                                    {this.state.error.toString()}
                                </div>
                            )}
                            <Button
                                onClick={() => window.location.reload()}
                                className="w-full bg-red-600 hover:bg-red-700"
                            >
                                <RefreshCw className="size-4 mr-2" />
                                Reload Application
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            );
        }

        return this.props.children;
    }
}
