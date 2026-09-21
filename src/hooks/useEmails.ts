import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ListQuery } from "../lib/api";
import type { EmailRecord } from "../server/types";
import { useAuth } from "../contexts/AuthContext";

const PAGE_SIZE = 100;

export function useEmails(accountEmail: string | null, folder: string | null, bounds: ListQuery = {}) {
  // Everything but the dates that narrows the list, as one string (the categories, favorites, read / unread).
  const categoryKey = `${(bounds.categories ?? []).join("\u0001")}\u0002${bounds.flagged ? "f" : ""}\u0002${bounds.read ?? ""}`;
  const { token } = useAuth();
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Identifies the current account+folder; responses that arrive for an older one are dropped.
  const viewKey = `${accountEmail}/${folder}/${bounds.after ?? ""}/${bounds.before ?? ""}/${categoryKey}`;
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;
  const loadedCountRef = useRef(0);
  const loadingMoreRef = useRef(false);

  // `keepLoaded` re-fetches as many messages as are already on screen (so a refresh after an action or
  // a sync doesn't throw away pages the user scrolled through); a folder switch starts over at page 1.
  const load = useCallback(
    async (keepLoaded: boolean) => {
      if (!token || !accountEmail || !folder) {
        setEmails([]);
        setHasMore(false);
        loadedCountRef.current = 0;
        return;
      }
      const key = viewKeyRef.current;
      const limit = keepLoaded ? Math.max(PAGE_SIZE, loadedCountRef.current) : PAGE_SIZE;
      setLoading(true);
      setError(null);
      try {
        const page = await api.listEmails(token, accountEmail, folder, { limit, ...bounds });
        if (viewKeyRef.current !== key) return;
        setEmails(page);
        setHasMore(page.length >= limit);
        loadedCountRef.current = page.length;
      } catch (err) {
        if (viewKeyRef.current !== key) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (viewKeyRef.current === key) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, accountEmail, folder, bounds.after, bounds.before, categoryKey]
  );

  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    loadedCountRef.current = 0;
    setHasMore(false);
    load(false);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!token || !accountEmail || !folder || loadingMoreRef.current || !hasMore) return;
    const key = viewKeyRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await api.listEmails(token, accountEmail, folder, {
        limit: PAGE_SIZE,
        offset: loadedCountRef.current,
        ...bounds,
      });
      if (viewKeyRef.current !== key) return;
      // New mail arriving at the top shifts later pages down by one, so an item can show up twice.
      setEmails(prev => {
        const seen = new Set(prev.map(e => e.id));
        const next = [...prev, ...page.filter(e => !seen.has(e.id))];
        loadedCountRef.current = next.length;
        return next;
      });
      setHasMore(page.length >= PAGE_SIZE);
    } catch (err) {
      if (viewKeyRef.current === key) setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, accountEmail, folder, hasMore, bounds.after, bounds.before, categoryKey]);

  const patchLocal = useCallback((id: number, patch: Partial<EmailRecord>) => {
    setEmails(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const removeLocal = useCallback((id: number) => {
    setEmails(prev => {
      const next = prev.filter(e => e.id !== id);
      loadedCountRef.current = next.length;
      return next;
    });
  }, []);

  return { emails, loading, loadingMore, hasMore, error, refresh, loadMore, patchLocal, removeLocal };
}
