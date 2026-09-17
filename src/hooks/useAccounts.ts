import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Account } from "../server/types";
import { useAuth } from "../contexts/AuthContext";

export function useAccounts() {
  const { token } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      setAccounts(await api.listAccounts(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { accounts, loading, error, refresh };
}
