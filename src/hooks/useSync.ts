import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { DownloadJob } from "../server/types";
import { useAuth } from "../contexts/AuthContext";

const POLL_INTERVAL_MS = 700;

export function useSync(accountEmail: string | null, onComplete?: () => void) {
  const { token } = useAuth();
  const [job, setJob] = useState<DownloadJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollHandle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fail = useCallback((message: string) => {
    setError(message);
    toast.error(message);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollHandle.current) clearTimeout(pollHandle.current);
    pollHandle.current = null;
  }, []);

  const poll = useCallback(
    (jobId: number) => {
      if (!token || !accountEmail) return;

      const tick = async () => {
        try {
          const latest = await api.getDownloadJob(token, accountEmail, jobId);
          setJob(latest);

          if (latest.status === "completed" || latest.status === "failed") {
            stopPolling();
            if (latest.status === "failed") fail(latest.error ?? "Sync failed");
            onComplete?.();
            return;
          }
          pollHandle.current = setTimeout(tick, POLL_INTERVAL_MS);
        } catch (err) {
          stopPolling();
          fail(err instanceof Error ? err.message : String(err));
        }
      };

      tick();
    },
    [token, accountEmail, onComplete, stopPolling, fail]
  );

  const start = useCallback(
    async (folder = "INBOX") => {
      if (!token || !accountEmail) return;
      setError(null);
      try {
        const created = await api.triggerDownload(token, accountEmail, folder);
        setJob(created);
        poll(created.id);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    },
    [token, accountEmail, poll, fail]
  );

  const isRunning = job?.status === "pending" || job?.status === "running";

  return { job, isRunning, error, start };
}
