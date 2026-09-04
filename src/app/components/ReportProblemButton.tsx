/**
 * Report a problem — single-tap "send context to the operator" for pilot users.
 *
 * Captures a useful context bundle (URL, viewport, last auth, last entry, console
 * errors if available) and either:
 *  - POSTs to a configured VITE_FEEDBACK_URL (Slack webhook, Formspree, etc.)
 *  - Falls back to a clipboard copy + toast so the user can paste into email
 *
 * Hidden by default; enable with VITE_ENABLE_REPORT_PROBLEM=true or
 * `?report=1` in the URL.
 */
import { useState } from 'react';
import { Bug, Loader2, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';

interface ContextSnapshot {
    capturedAt: string;
    url: string;
    userAgent: string;
    viewport: { w: number; h: number };
    localStorage: Record<string, string>;
    description: string;
}

function captureContext(description: string): ContextSnapshot {
    const ls: Record<string, string> = {};
    try {
        for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (!k) continue;
            // Don't leak Firebase auth tokens
            if (k.includes('firebase') || k.toLowerCase().includes('auth')) continue;
            try {
                ls[k] = window.localStorage.getItem(k) || '';
            } catch {
                /* ignore */
            }
        }
    } catch {
        /* ignore */
    }
    return {
        capturedAt: new Date().toISOString(),
        url: window.location.href,
        userAgent: navigator.userAgent,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        localStorage: ls,
        description,
    };
}

function envFlag(name: string, paramName: string): boolean {
    if (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string | undefined> }).env?.[name] === 'true') return true;
    if (typeof window !== 'undefined') {
        return new URLSearchParams(window.location.search).get(paramName) === '1';
    }
    return false;
}

function getWebhookUrl(): string | null {
    const envUrl = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_FEEDBACK_URL;
    if (typeof envUrl === 'string' && envUrl.length > 0) return envUrl;
    return null;
}

export function ReportProblemButton() {
    const enabled = envFlag('VITE_ENABLE_REPORT_PROBLEM', 'report');
    const [open, setOpen] = useState(false);
    const [description, setDescription] = useState('');
    const [sending, setSending] = useState(false);

    if (!enabled) return null;

    const send = async () => {
        if (!description.trim()) {
            toast.error('Please describe what went wrong.');
            return;
        }
        setSending(true);
        const ctx = captureContext(description.trim());
        const payload = JSON.stringify(ctx, null, 2);
        const url = getWebhookUrl();

        try {
            if (url) {
                const r = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: payload }),
                });
                if (!r.ok) throw new Error(`Webhook ${r.status}`);
                toast.success('Report sent. Thanks — we’ll take a look.');
            } else {
                // No webhook configured — copy to clipboard
                await navigator.clipboard.writeText(payload);
                toast.success('Copied to clipboard. Paste it into email/Slack to the admin.');
            }
            setDescription('');
            setOpen(false);
        } catch {
            // Last-resort fallback: clipboard
            try {
                await navigator.clipboard.writeText(payload);
                toast.warning('Could not auto-send. Copied to clipboard — please paste it to the admin.');
            } catch {
                toast.error('Could not send or copy. Please screenshot this page and email it.');
            }
        } finally {
            setSending(false);
        }
    };

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="fixed bottom-4 left-4 z-[9998] h-10 px-3 rounded-full bg-amber-500 text-white shadow-xl flex items-center gap-1.5 text-sm font-semibold hover:bg-amber-600 transition"
                aria-label="Report a problem"
                title="Report a problem"
            >
                <Bug className="h-4 w-4" />
                Report
            </button>
            {open && (
                <div className="fixed bottom-16 left-4 z-[9998] w-80 rounded-2xl bg-white shadow-2xl border border-amber-200 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Bug className="h-4 w-4 text-amber-600" />
                            <h3 className="font-bold text-slate-900 text-sm">Report a problem</h3>
                        </div>
                        <button onClick={() => setOpen(false)} aria-label="Close report panel" className="text-slate-400 hover:text-slate-700">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                    <p className="text-xs text-slate-500">
                        Describe what happened. Your page URL, browser, and local state are included automatically.
                    </p>
                    <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={5}
                        placeholder="e.g. Lunch button stopped working after I clicked Clock In twice."
                        className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm resize-y"
                    />
                    <Button
                        onClick={send}
                        disabled={sending || !description.trim()}
                        size="sm"
                        className="w-full bg-amber-500 hover:bg-amber-600 text-white"
                    >
                        {sending ? (
                            <>
                                <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Sending…
                            </>
                        ) : (
                            <>
                                <Send className="h-4 w-4 mr-1" /> Send
                            </>
                        )}
                    </Button>
                </div>
            )}
        </>
    );
}
