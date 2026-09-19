import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { DownloadJob } from "../server/types";
import { useAuth } from "../contexts/AuthContext";

const POLL_INTERVAL_MS = 700;

/**
 * Sync jobs for all accounts in one place: the sidebar's "Sync now" buttons and the periodic
 * auto-sync (see the user setting `syncIntervalMinutes`) go through the same `start`, so a manual
 * click during an automatic run — or two ticks in a row — never launches a second job for an account,
 * and both show the same progress. `onAccountComplete` fires when a job finishes, successfully or not.
 */
export function useSyncJobs(onAccountComplete: (accountEmail: string) => void) {
  const { token } = useAuth();
  const [jobs, setJobs] = useState<Record<string, DownloadJob>>({});
  const running = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const onCompleteRef = useRef(onAccountComplete);
  onCompleteRef.current = onAccountComplete;

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    []
  );

  const finish = useCallback((accountEmail: string) => {
    running.current.delete(accountEmail);
    timers.current.delete(accountEmail);
    onCompleteRef.current(accountEmail);
  }, []);

  const poll = useCallback(
    (accountEmail: string, jobId: number) => {
      const tick = async () => {
        try {
          const latest = await api.getDownloadJob(token!, accountEmail, jobId);
          setJobs(prev => ({ ...prev, [accountEmail]: latest }));

          if (latest.status === "completed" || latest.status === "failed") {
            if (latest.status === "failed") toast.error(latest.error ?? "Sync failed");
            finish(accountEmail);
            return;
          }
          timers.current.set(accountEmail, setTimeout(tick, POLL_INTERVAL_MS));
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
          finish(accountEmail);
        }
      };
      tick();
    },
    [token, finish]
  );

  /** Starts syncing an account (every folder, or just `folder`); a no-op while one is already running for it. `silent` skips the error toast when the job couldn't even be started (used by the automatic sync). */
  const start = useCallback(
    async (accountEmail: string, options: { folder?: string; silent?: boolean } = {}) => {
      if (!token || running.current.has(accountEmail)) return;
      running.current.add(accountEmail);
      try {
        const created = await api.triggerDownload(token, accountEmail, options.folder);
        setJobs(prev => ({ ...prev, [accountEmail]: created }));
        poll(accountEmail, created.id);
      } catch (err) {
        running.current.delete(accountEmail);
        if (!options.silent) toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [token, poll]
  );

  return { jobs, start };
}
