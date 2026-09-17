import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { EmailRecord } from "../server/types";
import { useAuth } from "../contexts/AuthContext";

export function useEmails(accountEmail: string | null, folder: string | null) {
  const { token } = useAuth();
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token || !accountEmail || !folder) {
      setEmails([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setEmails(await api.listEmails(token, accountEmail, folder, { limit: 100 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token, accountEmail, folder]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const patchLocal = useCallback((id: number, patch: Partial<EmailRecord>) => {
    setEmails(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const removeLocal = useCallback((id: number) => {
    setEmails(prev => prev.filter(e => e.id !== id));
  }, []);

  return { emails, loading, error, refresh, patchLocal, removeLocal };
}
