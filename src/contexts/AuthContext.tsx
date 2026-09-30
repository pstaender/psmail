import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";

interface StoredSession {
  token: string;
  userId: number;
  username: string;
}

interface AuthContextValue {
  token: string | null;
  userId: number | null;
  username: string | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  /** The signed-in user was renamed: keeps this browser's session (and what it shows) in step. */
  renameUser: (username: string) => void;
  logout: () => void;
  /** Set after the client was signed out by the server rejecting a request as unauthorized (see onSessionExpired in lib/api) — shown on the login screen, and cleared on the next login. */
  sessionExpiredMessage: string | null;
}

const STORAGE_KEY = "psmail.session";

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [ready, setReady] = useState(false);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  // No network call (the server already considers the session gone — that's why we're here) and no
  // dependency on `session`, so a request racing in right after this can't re-trigger it recursively.
  const forceLogout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    window.history.replaceState(null, "", "/"); // the next sign-in shouldn't land on this profile's deep link
    setSession(null);
    setSessionExpiredMessage("Your session ended — please sign in again.");
  }, []);

  useEffect(() => {
    api.onSessionExpired(forceLogout);
    return () => api.onSessionExpired(null);
  }, [forceLogout]);

  useEffect(() => {
    const stored = readStoredSession();
    if (!stored) {
      setReady(true);
      return;
    }

    // Validate the persisted token still works before trusting it.
    api
      .listAccounts(stored.token)
      .then(() => setSession(stored))
      .catch(() => localStorage.removeItem(STORAGE_KEY))
      .finally(() => setReady(true));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password);
    const next: StoredSession = { token: result.token, userId: result.user.id, username: result.user.username };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSession(next);
    setSessionExpiredMessage(null);
  }, []);

  const renameUser = useCallback((username: string) => {
    setSession(current => {
      if (!current) return current;
      const next = { ...current, username };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const logout = useCallback(() => {
    if (session) api.logout(session.token).catch(() => {});
    localStorage.removeItem(STORAGE_KEY);
    window.history.replaceState(null, "", "/"); // the next sign-in shouldn't land on this profile's deep link
    setSession(null);
    setSessionExpiredMessage(null);
  }, [session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      token: session?.token ?? null,
      userId: session?.userId ?? null,
      username: session?.username ?? null,
      ready,
      login,
      renameUser,
      logout,
      sessionExpiredMessage,
    }),
    [session, ready, login, renameUser, logout, sessionExpiredMessage]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
