'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserSupabase } from '@ingestio/lib/supabase/client';
import type {
  JobStatus,
  JobStatusResponse,
  UploadJobResponse,
} from '@ingestio/shared';

const POLL_INTERVAL_MS = 2000;
const TOKEN_STORAGE_KEY = 'ingestio.access-token';
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const NOTICE_DURATION_MS = 4500;

const ACTIVE_JOB_STORAGE_KEY = 'active_job_id';

// NEXT_PUBLIC_ vars are inlined at build time; when both are set, the demo
// entry point signs in an anonymous Supabase session instead of requiring a
// personal access token.
const DEMO_AUTH_AVAILABLE = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

interface Notice {
  kind: 'success' | 'error';
  text: string;
}

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['completed', 'failed']);

const STATUS_META: Record<JobStatus, { label: string; badge: string; dot: string; bar: string }> = {
  pending: {
    label: 'Pending',
    badge: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
    dot: 'bg-amber-400',
    bar: 'bg-amber-400',
  },
  processing: {
    label: 'Processing',
    badge: 'bg-blue-500/10 text-blue-300 ring-blue-500/30',
    dot: 'bg-blue-400',
    bar: 'bg-blue-400',
  },
  completed: {
    label: 'Completed',
    badge: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30',
    dot: 'bg-emerald-400',
    bar: 'bg-emerald-400',
  },
  failed: {
    label: 'Failed',
    badge: 'bg-red-500/10 text-red-300 ring-red-500/30',
    dot: 'bg-red-400',
    bar: 'bg-red-400',
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function truncateJobId(jobId: string | undefined): string {
  if (!jobId) return 'N/A';
  return jobId.slice(0, 8) + '…';
}

export default function Home() {
  const supabase = getBrowserSupabase();

  const [token, setToken] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) return stored;
    return '';
  });
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [job, setJob] = useState<JobStatusResponse | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDemoSigningIn, setIsDemoSigningIn] = useState(false);
  const [isDemoSession, setIsDemoSession] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobStatusResponse[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((kind: Notice['kind'], text: string) => {
    setNotice({ kind, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
  }, []);

  // Demo path: create an anonymous Supabase session and use its access token
  // as the Bearer token for uploads + status polls. Requires "Allow anonymous
  // sign-ins" in the Supabase project's Auth settings.
  const handleDemoSignIn = useCallback(async () => {
    const supabaseClient = getBrowserSupabase();
    if (!supabaseClient) {
      showNotice('error', 'Demo auth is not configured (NEXT_PUBLIC_SUPABASE_* missing).');
      return;
    }
    setIsDemoSigningIn(true);
    try {
      const { data, error } = await supabaseClient.auth.signInAnonymously();
      if (error) throw error;
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        throw new Error('Anonymous sign-in returned no session.');
      }
      setToken(accessToken);
      setIsDemoSession(true);
      showNotice('success', 'Demo guest session active — you can now upload a PDF.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      showNotice('error', `Demo sign-in failed: ${message}`);
    } finally {
      setIsDemoSigningIn(false);
    }
  }, [showNotice]);

  // === 2. Session Persistence & 1-Click Guest Auth ===
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!supabase) return;
    // Check for existing session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        const accessToken = session.access_token;
        setToken(accessToken);
        setIsDemoSession(!!session.user?.app_metadata?.is_guest);
      }
    });
    // Keep token in sync with localStorage
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  }, [supabase]);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  // === 3. Active Job Recovery (localStorage) ===
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedJobId = window.localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
    if (!savedJobId) return;
    if (jobId !== savedJobId) {
      setJobId(savedJobId);
    }
    if (job && TERMINAL_STATUSES.has(job.status)) {
      window.localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
    }
  }, [jobId, job?.status]);

  // Poll the live job status every 2s until it reaches a terminal state.
  // On mount, if localStorage has an active_job_id and the job is pending/processing,
  // the polling will automatically resume via the jobId dependency.
  useEffect(() => {
    if (!jobId || !token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer) clearInterval(timer);
    };
    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          if (!cancelled) setError('Session expired — re-enter your token.');
          stop();
          return;
        }
        if (res.status === 404) {
          if (!cancelled) setError('Job not found — it may have been cleaned up.');
          stop();
          return;
        }
        if (!res.ok) {
          if (!cancelled) setError(`Status check failed (HTTP ${res.status}).`);
          stop();
          return;
        }
        const data = (await res.json()) as JobStatusResponse;
        if (cancelled) return;
        setJob(data);
        setError(null);
        if (TERMINAL_STATUSES.has(data.status)) {
          window.localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
          setJobId(null);
        }
      } catch {
        // Transient network error — keep polling, the next tick retries.
      }
    };
    void poll();
    timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [jobId, token]);

  // Fetch recent jobs history when authenticated
  useEffect(() => {
    if (!supabase || !token.trim()) return;
    supabase
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10)
      .then(({ data, error }) => {
        if (error) {
          setError('Failed to fetch job history.');
          return;
        }
        if (data) {
          setRecentJobs(
            data.map((j: any) => ({
              job_id: j.id || j.job_id || '',
              status: (j.status || 'pending') as JobStatus,
              progress: j.progress ?? 0,
              result: j.result_json ?? null,
              created_at: j.created_at || new Date().toISOString(),
              updated_at: j.updated_at || new Date().toISOString(),
              error: j.error || null,
            })) as JobStatusResponse[],
          );
        }
      });
  }, [supabase, token]);

  const acceptFile = useCallback((candidate: File | undefined) => {
    if (!candidate) return;
    if (!isPdf(candidate)) {
      setError('Only PDF files are supported.');
      return;
    }
    if (candidate.size > MAX_FILE_SIZE_BYTES) {
      setError('File exceeds the 20 MB limit.');
      return;
    }
    setFile(candidate);
    setError(null);
  }, []);

  // Save active jobId to localStorage when upload starts
  const startIngestion = async () => {
    if (!file || !token) return;
    setIsUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/jobs/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const body = (await res.json().catch(() => null)) as
        | UploadJobResponse
        | { error?: string }
        | null;
      if (res.status === 202 && body && 'job_id' in body) {
        setJob({
          job_id: body.job_id,
          status: 'pending',
          progress: 0,
          result: null,
          error: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        setJobId(body.job_id);
        // Save active jobId to localStorage for recovery
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, body.job_id);
        }
        setFile(null); // dropzone resets for the next document
        return;
      }
      const message =
        body && 'error' in body && body.error ? body.error : `Upload failed (HTTP ${res.status}).`;
      setError(
        res.status === 401
          ? 'Authentication failed — check your token and try again.'
          : message,
      );
    } catch {
      setError('Network error — could not reach the upload endpoint.');
    } finally {
      setIsUploading(false);
    }
  };

  const reset = () => {
    setJob(null);
    setJobId(null);
    // Clear active job from localStorage on reset
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
    }
    setError(null);
    setFile(null);
  };

  const isPolling = job !== null && !TERMINAL_STATUSES.has(job.status);
  const canSubmit = file !== null && token.trim().length > 0 && !isUploading && !isPolling;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10">
      {/* === 1. Header, Explanation & Project Links === */}
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 border border-slate-700">
          <img
            src="/assets/ingestio-logo.png"
            alt="IngestIO"
            className="h-full w-full object-contain"
            style={{ maxWidth: '100%' }}
          />
        </div>
        <div className="flex-1 flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">IngestIO</h1>
          <p className="text-sm text-slate-400">
            Asynchronous background document extraction platform powered by BullMQ,
            Redis, Supabase, and Google Gemini AI.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/naimr02/IngestIO"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-cyan-500 hover:text-cyan-300"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.438.636-1.775-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.027A9.564 9.564 0 0112 6.845c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              />
            </svg>
            GitHub
            <span className="ml-1 text-xs font-medium bg-cyan-500/20 px-2 rounded">
              external
            </span>
          </a>
        </div>
      </header>

      {/* How It Works collapsible banner */}
      <div className="rounded-2xl border border-slate-700 bg-slate-900/60 p-4 mb-6">
        <details className="grid gap-2">
          <summary className="flex items-center gap-2 text-sm font-medium text-slate-300 cursor-pointer">
            How It Works
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
            </svg>
          </summary>
          <div className="grid grid-cols-3 gap-4 text-sm text-slate-400">
            <div>
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mb-2">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <strong>Step 1:</strong> Upload a PDF (Stored securely in Supabase Storage).
            </div>
            <div>
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mb-2">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <line x1="9" y1="1" x2="9" y2="4" />
                  <line x1="15" y1="1" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="23" />
                  <line x1="15" y1="20" x2="15" y2="23" />
                  <line x1="20" y1="9" x2="23" y2="9" />
                  <line x1="20" y1="15" x2="23" y2="15" />
                  <line x1="1" y1="9" x2="4" y2="9" />
                  <line x1="1" y1="15" x2="4" y2="15" />
                </svg>
              </div>
              <strong>Step 2:</strong> Asynchronous BullMQ worker extracts structured JSON using gemini-3.6-flash.
            </div>
            <div>
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mb-2">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 2 7 12 12 22 7 12 2" />
                  <polyline points="2 17 12 22 22 17" />
                  <polyline points="2 12 12 17 22 12" />
                </svg>
              </div>
              <strong>Step 3:</strong> View live progress and receive real-time extracted JSON or HMAC-signed webhooks.
            </div>
          </div>
        </details>
      </div>

      {/* === 4. Recent Jobs History Dashboard === */}
      {supabase && token.trim() && recentJobs.length > 0 && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 mb-6">
          <h2 className="text-sm font-medium text-slate-300 mb-3">Recent Extractions</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-slate-400">
              <thead>
                <tr className="border-b border-slate-700 border-y-2">
                  <th className="w-32 text-left text-slate-500 sticky left-0">Job ID</th>
                  <th className="text-left text-slate-500">Created</th>
                  <th className="text-left text-slate-500">Status</th>
                  <th className="text-left text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {recentJobs.map((j) => (
                  <tr key={j.job_id || 'N/A'} className="border-b border-slate-700 hover:bg-slate-900">
                    <td className="font-mono text-slate-300 truncate">
                      {truncateJobId(j.job_id)}
                    </td>
                    <td className="text-xs">
                      {j.created_at ? new Date(j.created_at).toLocaleString() : 'N/A'}
                    </td>
                    <td>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
                          j.status === 'pending'
                            ? 'bg-amber-500/10 text-amber-300'
                            : j.status === 'processing'
                            ? 'bg-blue-500/10 text-blue-300'
                            : j.status === 'completed'
                            ? 'bg-emerald-500/10 text-emerald-300'
                            : 'bg-red-500/10 text-red-300'
                        }`}
                      >
                        {j.status || 'pending'}
                      </span>
                    </td>
                    <td className="text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          setJob({
                            job_id: j.job_id,
                            status: j.status,
                            progress: j.progress,
                            result: j.result,
                            error: j.error,
                            created_at: j.created_at,
                            updated_at: j.updated_at,
                          });
                        }}
                        className="text-cyan-400 hover:underline"
                      >
                        View Output
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Upload zone */}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 mb-6">
        <div className="mb-2 flex items-center gap-2">
          <label htmlFor="token" className="block text-sm font-medium text-slate-300">
            Supabase access token
          </label>
          {isDemoSession && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/30">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Demo guest session
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setIsDemoSession(false);
            }}
            placeholder="Paste a Supabase JWT (Project Settings → API)"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {DEMO_AUTH_AVAILABLE && (
            <button
              type="button"
              onClick={handleDemoSignIn}
              disabled={isDemoSigningIn}
              className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-cyan-500 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              title="Sign in as an anonymous guest via Supabase Auth"
            >
              {isDemoSigningIn ? 'Signing in…' : 'Use demo key'}
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Stored locally in your browser. Authenticates uploads and live status checks.
        </p>
      </section>

      <section
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
          isDragging
            ? 'border-cyan-400 bg-cyan-500/10'
            : 'border-slate-700 bg-slate-900/60 hover:border-slate-500'
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          acceptFile(e.dataTransfer.files[0]);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        aria-label="Upload a PDF"
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => acceptFile(e.target.files?.[0])}
        />
        {file ? (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/15 text-2xl">
              📄
            </div>
            <div>
              <p className="font-medium text-slate-100">{file.name}</p>
              <p className="text-sm text-slate-400">{formatBytes(file.size)}</p>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setFile(null);
              }}
              className="text-xs text-slate-500 underline-offset-2 hover:text-red-400 hover:underline"
            >
              Remove file
            </button>
          </>
        ) : (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-2xl">
              📄
            </div>
            <div>
              <p className="font-medium text-slate-200">
                Drag & drop a PDF here, or <span className="text-cyan-400">browse</span>
              </p>
              <p className="text-sm text-slate-500">Up to 20 MB · validated server-side too</p>
            </div>
          </>
        )}
      </section>

      {notice && (
        <div className="fixed inset-x-0 top-4 z-50 flex justify-center px-4">
          <div
            role="status"
            className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg ring-1 ${
              notice.kind === 'success'
                ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
                : 'bg-red-500/15 text-red-300 ring-red-500/30'
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                notice.kind === 'success' ? 'bg-emerald-400' : 'bg-red-400'
              }`}
            />
            {notice.text}
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={startIngestion}
          disabled={!canSubmit}
          className="rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-900/40 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isUploading ? 'Uploading…' : 'Start Ingestion'}
        </button>
        {job && (
          <button
            type="button"
            onClick={reset}
            className="rounded-xl border border-slate-700 px-5 py-2.5 text-sm text-slate-300 hover:border-slate-500"
          >
            Run another document
          </button>
        )}
      </div>

      {job && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ${STATUS_META[job.status].badge}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${STATUS_META[job.status].dot} ${
                    isPolling ? 'animate-pulse' : ''
                  }`}
                />
                {STATUS_META[job.status].label}
              </span>
              <span className="text-xs text-slate-500">Job {job.job_id.slice(0, 8)}…</span>
            </div>
            <span className="text-xs text-slate-500">{job.progress}%</span>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full rounded-full transition-all duration-500 ${STATUS_META[job.status].bar}`}
              style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
            />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-400">
            <div>
              <p className="text-slate-600">Created</p>
              <p>{new Date(job.created_at).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-slate-600">Last update</p>
              <p>{new Date(job.updated_at).toLocaleString()}</p>
            </div>
          </div>

          {job.status === 'failed' && job.error && (
            <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300">
              {job.error}
            </p>
          )}
        </section>
      )}

      {job?.status === 'completed' && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-300">Extracted result</h2>
            {job.result && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(JSON.stringify(job.result, null, 2))
                    .catch(() => {});
                }}
                className="text-xs text-slate-500 hover:text-cyan-400"
              >
                Copy JSON
              </button>
            )}
          </div>
          {job.result ? (
            <pre className="max-h-96 overflow-auto rounded-xl bg-slate-950 p-4 font-mono text-xs leading-relaxed text-emerald-200 ring-1 ring-slate-800">
              {JSON.stringify(job.result, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-slate-500">Job completed with no structured result.</p>
          )}
        </section>
      )}

      {/* === 5. Disclaimer Notice === */}
      <footer className="mt-auto pt-6 text-center text-xs text-slate-600">
        Uploads go to Supabase Storage · extraction runs on BullMQ + Gemini · status streamed via
        polling
      </footer>
      <div className="mt-4 p-4 rounded-xl bg-slate-950 border border-slate-800/50 text-center text-xs text-slate-500">
        Disclaimer: IngestIO is an open-source demonstration environment. Uploaded documents are
        processed asynchronously via Google Gemini AI and stored temporarily for demo evaluation. Do
        not upload sensitive personal, financial, or confidential documents.
      </div>
    </main>
  );
}