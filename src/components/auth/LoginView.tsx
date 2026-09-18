import { useEffect, useState } from "react";
import { Mail, Loader2, UserPlus } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { User } from "../../server/types";

export function LoginView() {
  const { login } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [selected, setSelected] = useState<User | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listUsers()
      .then(setUsers)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setUsersLoading(false));
  }, []);

  async function submitLogin(name: string) {
    setBusy(true);
    setError(null);
    try {
      await login(name, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Clicking a profile tries logging in with an empty password first — if the account has
   * none set, this succeeds immediately and the password prompt never has to appear at all.
   * Any failure here is expected and silent (not a real login mistake yet, just a probe): it
   * just falls through to expanding the password form, exactly as clicking used to always do.
   */
  async function selectUser(user: User) {
    if (selected?.id === user.id) {
      setSelected(null);
      setPassword("");
      return;
    }
    setSelected(user);
    setPassword("");
    setError(null);
    setBusy(true);
    try {
      await login(user.username, "");
    } catch {
      // Needs a real password — the form below (already showing, since `selected` is set) is the fallback.
    } finally {
      setBusy(false);
    }
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createUser(username.trim(), password);
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full w-full flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center gap-2">
          <div className="rounded-full bg-primary/10 p-3">
            <Mail className="size-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">P.S.Mail</CardTitle>
          <CardDescription>Sign in to your profile to continue</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-destructive text-center">{error}</p>}

          {!creatingNew && (
            <>
              {usersLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-1.5">
                  {users.map(user => (
                    <div key={user.id}>
                      <button
                        type="button"
                        onClick={() => selectUser(user)}
                        disabled={busy}
                        className="w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left hover:bg-accent transition-colors disabled:pointer-events-none disabled:opacity-50"
                      >
                        <Avatar className="size-8">
                          <AvatarFallback>{user.username.slice(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{user.username}</span>
                      </button>

                      {selected?.id === user.id && (
                        <form
                          className="mt-2 flex flex-col gap-2 pl-1"
                          onSubmit={e => {
                            e.preventDefault();
                            submitLogin(user.username);
                          }}
                        >
                          <Input
                            type="password"
                            placeholder="Password"
                            autoFocus
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                          />
                          <Button type="submit" disabled={busy} size="sm">
                            {busy && <Loader2 className="size-4 animate-spin" />}
                            Sign in
                          </Button>
                        </form>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <Button variant="ghost" className="w-full" onClick={() => setCreatingNew(true)}>
                <UserPlus className="size-4" />
                New profile
              </Button>
            </>
          )}

          {creatingNew && (
            <form className="space-y-3" onSubmit={submitCreate}>
              <div className="space-y-1.5">
                <Label htmlFor="new-username">Username</Label>
                <Input id="new-username" autoFocus value={username} onChange={e => setUsername(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-password">Password (optional)</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" className="flex-1" onClick={() => setCreatingNew(false)}>
                  Back
                </Button>
                <Button type="submit" className="flex-1" disabled={busy}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  Create
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
