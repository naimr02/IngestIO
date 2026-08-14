'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBrowserSupabase } from '@ingestio/lib/supabase/client';
import type { JobStatus, JobStatusResponse, UploadJobResponse } from '@ingestio/shared';

const POLL_INTERVAL_MS = 2000;
const TOKEN_STORAGE_KEY = 'ingestio.access-token';
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const NOTICE_DURATION_MS = 4500;

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

export default function Home() {
  const [token, setToken] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
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
  const inputRef = useRef<HTMLInputElement>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((kind: Notice['kind'], text: string) => {
    setNotice({ kind, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  }, [token]);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  /**
   * Demo path: create an anonymous Supabase session and use its access token
   * as the Bearer token for uploads + status polls. Requires "Allow anonymous
   * sign-ins" in the Supabase project's Auth settings.
   */
  const handleDemoSignIn = async () => {
    const supabase = getBrowserSupabase();
    if (!supabase) {
      showNotice('error', 'Demo auth is not configured (NEXT_PUBLIC_SUPABASE_* missing).');
      return;
    }
    setIsDemoSigningIn(true);
    try {
      const { data, error } = await supabase.auth.signInAnonymously();
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
  };

  // Poll the live job status every 2s until it reaches a terminal state.
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
        if (TERMINAL_STATUSES.has(data.status)) stop();
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
    setError(null);
    setFile(null);
  };

  const isPolling = job !== null && !TERMINAL_STATUSES.has(job.status);
  const canSubmit = file !== null && token.trim().length > 0 && !isUploading && !isPolling;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 border border-slate-700">
          <img
            src="/assets/ingestio-logo.png"
            alt="IngestIO"
            className="h-full w-full object-contain"
            style={{ maxWidth: '100%' }}
          />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">IngestIO</h1>
          <p className="text-sm text-slate-400">Document extraction dashboard</p>
        </div>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
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
                Drag &amp; drop a PDF here, or <span className="text-cyan-400">browse</span>
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
            <span className="text-sm font-semibold text-slate-200">{job.progress}%</span>
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

      <footer className="mt-auto pt-6 text-center text-xs text-slate-600">
        Uploads go to Supabase Storage · extraction runs on BullMQ + Gemini · status streamed via
        polling
      </footer>
    </main>
  );
}
