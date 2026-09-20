import { useCallback, useEffect, useRef, useState } from "react";
import { api, type UnifiedKind } from "../lib/api";
import type { SearchResult } from "../server/models/search";
import { useAuth } from "../contexts/AuthContext";

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 100;

/**
 * The cross-account result list shown in place of a folder's messages: a debounced search (a
 * non-empty query) or, when there's no query, a unified mailbox (all accounts' Inboxes or Sents).
 * Both come back as SearchResults and page in `PAGE_SIZE` chunks via `loadMore`. Empty queries with
 * no unified mailbox return nothing without hitting the API.
 */
export function useSearchResults(query: string, unified: UnifiedKind | null = null, bounds: { after?: string; before?: string } = {}) {
  const { token } = useAuth();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = query.trim();
  // A date filter narrows a search too: the same query, within the window.
  const window = bounds;
  const windowKey = `${window.after ?? ""}:${window.before ?? ""}`;
  const sourceKey = trimmed ? `search:${trimmed}:${windowKey}` : unified ? `unified:${unified}:${windowKey}` : "";
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;
  const loadedCountRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const fetchPage = useCallback(
    (limit: number, offset: number) =>
      trimmed ? api.search(token!, trimmed, { limit, offset, ...window }) : api.listUnified(token!, unified!, { limit, offset, ...window }),
    [token, trimmed, unified, window.after, window.before]
  );

  // `keepLoaded` re-fetches as many results as are already showing, so a refresh doesn't drop scrolled-in pages.
  const load = useCallback(
    async (keepLoaded: boolean) => {
      const key = sourceKeyRef.current;
      const limit = keepLoaded ? Math.max(PAGE_SIZE, loadedCountRef.current) : PAGE_SIZE;
      try {
        const data = await fetchPage(limit, 0);
        if (sourceKeyRef.current !== key) return;
        setResults(data);
        setHasMore(data.length >= limit);
        loadedCountRef.current = data.length;
        setError(null);
      } catch (err) {
        if (sourceKeyRef.current === key) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (sourceKeyRef.current === key) setLoading(false);
      }
    },
    [fetchPage]
  );

  useEffect(() => {
    loadedCountRef.current = 0;
    if (!token || !sourceKey) {
      setResults([]);
      setHasMore(false);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    // Typing is debounced; picking a unified mailbox loads immediately.
    const handle = setTimeout(() => load(false), trimmed ? DEBOUNCE_MS : 0);
    return () => clearTimeout(handle);
  }, [token, sourceKey, trimmed, load]);

  const loadMore = useCallback(async () => {
    if (!token || !sourceKey || loadingMoreRef.current || !hasMore) return;
    const key = sourceKeyRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchPage(PAGE_SIZE, loadedCountRef.current);
      if (sourceKeyRef.current !== key) return;
      // A new message arriving shifts later pages down by one, so an item can show up twice.
      setResults(prev => {
        const seen = new Set(prev.map(r => r.id));
        const next = [...prev, ...page.filter(r => !seen.has(r.id))];
        loadedCountRef.current = next.length;
        return next;
      });
      setHasMore(page.length >= PAGE_SIZE);
    } catch (err) {
      if (sourceKeyRef.current === key) setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [token, sourceKey, hasMore, fetchPage]);

  const refresh = useCallback(() => {
    if (token && sourceKeyRef.current) load(true);
  }, [token, load]);

  // Search results are a separate copy of the data from the per-folder message list, so
  // actions like mark-as-read (triggered while a result is open) need to patch this list too
  // for the displayed unread state to stay in sync. `id` is safe as the sole key here even
  // though results span accounts: email ids are globally unique (one shared `emails` table).
  const patchLocal = useCallback((id: number, patch: Partial<SearchResult>) => {
    setResults(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const removeLocal = useCallback((id: number) => {
    setResults(prev => {
      const next = prev.filter(r => r.id !== id);
      loadedCountRef.current = next.length;
      return next;
    });
  }, []);

  return { results, loading, loadingMore, hasMore, error, loadMore, refresh, patchLocal, removeLocal };
}
