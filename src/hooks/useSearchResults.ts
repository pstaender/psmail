import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { SearchResult } from "../server/models/search";
import { useAuth } from "../contexts/AuthContext";

const DEBOUNCE_MS = 300;

/** Debounced cross-account search; empty/whitespace-only queries return no results without hitting the API. */
export function useSearchResults(query: string) {
  const { token } = useAuth();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!token || !trimmed) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const handle = setTimeout(async () => {
      try {
        const data = await api.search(token, trimmed);
        if (!cancelled) {
          setResults(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [token, query]);

  // Search results are a separate copy of the data from the per-folder message list, so
  // actions like mark-as-read (triggered while a result is open) need to patch this list too
  // for the displayed unread state to stay in sync. `id` is safe as the sole key here even
  // though results span accounts: email ids are globally unique (one shared `emails` table).
  const patchLocal = useCallback((id: number, patch: Partial<SearchResult>) => {
    setResults(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const removeLocal = useCallback((id: number) => {
    setResults(prev => prev.filter(r => r.id !== id));
  }, []);

  return { results, loading, error, patchLocal, removeLocal };
}
