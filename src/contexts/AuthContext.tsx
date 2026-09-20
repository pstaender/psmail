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
  logout: () => void;
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
  }, []);

  const logout = useCallback(() => {
    if (session) api.logout(session.token).catch(() => {});
    localStorage.removeItem(STORAGE_KEY);
    window.history.replaceState(null, "", "/"); // the next sign-in shouldn't land on this profile's deep link
    setSession(null);
  }, [session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      token: session?.token ?? null,
      userId: session?.userId ?? null,
      username: session?.username ?? null,
      ready,
      login,
      logout,
    }),
    [session, ready, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
