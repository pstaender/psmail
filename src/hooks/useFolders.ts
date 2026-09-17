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

  return { folders, loading, error, refresh };
}
