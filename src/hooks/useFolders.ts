import { useCallback, useEffect, useRef, useState } from "react";
import { api, type FolderInfo } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

export function useFolders(accountEmail: string | null) {
  const { token } = useAuth();
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the mail server couldn't be reached and only the folders stored locally are listed (with the reason).
  const [warning, setWarning] = useState<string | null>(null);

  // Which account `folders` currently belongs to. A refresh for the *same* account keeps showing the
  // folders it already has (stale-while-revalidate) instead of blanking the tree behind a spinner —
  // only the very first load for an account (or a switch to another one) shows "Loading…".
  const loadedFor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token || !accountEmail) {
      loadedFor.current = null;
      setFolders([]);
      return;
    }
    const background = loadedFor.current === accountEmail;
    if (!background) {
      loadedFor.current = accountEmail;
      setFolders([]);
      setLoading(true);
    }
    try {
      const result = await api.listFolders(token, accountEmail, { onWarning: setWarning });
      if (loadedFor.current !== accountEmail) return;
      setFolders(result);
      setError(null);
    } catch (err) {
      if (loadedFor.current === accountEmail) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (loadedFor.current === accountEmail) setLoading(false);
    }
  }, [token, accountEmail]);

  // Showing an account's folders is two steps: the server's remembered list (instant) and then, in the background,
  // a live read from IMAP that picks up folders created or renamed elsewhere. IMAP can be very slow (Gmail took
  // 50 s), so nothing waits for it; if it fails, what's on screen stays — the error only matters when there is
  // nothing to show at all.
  useEffect(() => {
    let cancelled = false;
    refresh().then(() => {
      if (cancelled || !token || !accountEmail) return;
      api
        .listFolders(token, accountEmail, { live: true, onWarning: setWarning })
        .then(live => {
          if (!cancelled && loadedFor.current === accountEmail) setFolders(live);
        })
        .catch(err => {
          if (!cancelled && loadedFor.current === accountEmail) setError(prev => prev ?? (err instanceof Error ? err.message : String(err)));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [refresh, token, accountEmail]);

  /**
   * Optimistically nudges a folder's total/unread counts by a known delta, instead of waiting
   * for a full refresh (which re-lists folders live from IMAP — too slow/heavy to do on every
   * read/unread toggle, delete, or move). Clamped so a race with a real refresh can't leave
   * either count negative.
   */
  const patchCounts = useCallback((folder: string, deltas: { total?: number; unread?: number }) => {
    setFolders(prev =>
      prev.map(f =>
        f.path === folder
          ? { ...f, total: Math.max(0, f.total + (deltas.total ?? 0)), unread: Math.max(0, f.unread + (deltas.unread ?? 0)) }
          : f
      )
    );
  }, []);

  return { folders, loading, error, warning, refresh, patchCounts };
}
