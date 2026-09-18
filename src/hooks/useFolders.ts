import { useCallback, useEffect, useState } from "react";
import { api, type FolderInfo } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

export function useFolders(accountEmail: string | null) {
  const { token } = useAuth();
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token || !accountEmail) {
      setFolders([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setFolders(await api.listFolders(token, accountEmail));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token, accountEmail]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  return { folders, loading, error, refresh, patchCounts };
}
