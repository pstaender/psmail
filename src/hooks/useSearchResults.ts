import { useEffect, useState } from "react";
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

  return { results, loading, error };
}
