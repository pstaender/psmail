import { useEffect, useState } from "react";
import { Fingerprint, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { hasVault, passkeysAvailable, removeVault, savePassword, unlockPassword } from "@/lib/passkeyVault";
import { useAuth } from "@/contexts/AuthContext";
import type { User } from "../../server/types";
import logoUrl from "../../../logo/psmail_logo.svg";

export function LoginView() {
  const { login } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [selected, setSelected] = useState<User | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Offered when the browser can do passkeys: keep the password on this device, unlockable only with the passkey.
  const [rememberWithPasskey, setRememberWithPasskey] = useState(false);
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
      if (rememberWithPasskey && password !== "") {
        // The login succeeded, so the password is right; setting up the passkey may still fail or be cancelled — the
        // user is signed in either way (this screen is already gone, hence a toast).
        savePassword(name, password)
          .then(() => toast.success("Passkey unlock is set up on this device."))
          .catch(err => toast.error(err instanceof Error ? err.message : String(err)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Signs in with the password kept on this device, unlocked by the passkey (fingerprint / face / PIN / touch). */
  async function unlockAndLogin(name: string) {
    setBusy(true);
    setError(null);
    try {
      const saved = await unlockPassword(name);
      try {
        await login(name, saved);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // The password was changed elsewhere: what is stored is stale and would only fail again.
          removeVault(name);
          setError("The saved password no longer works — it was probably changed. Sign in with the password; you can set up passkey unlock again.");
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
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
    setRememberWithPasskey(false);
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
    // Scrolls when the card is taller than the window (many profiles, a small screen), with room above and below it.
    <div className="h-full w-full overflow-y-auto bg-muted/30">
      <div className="flex min-h-full items-center justify-center px-4 py-10 sm:py-14">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center gap-2">
          <img src={logoUrl} alt="P.S.Mail logo" className="size-20" />
          <CardTitle className="text-2xl" style={{ color: "#247ad7" }} >P.S.Mail</CardTitle>
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
                          {hasVault(user.username) && (
                            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => unlockAndLogin(user.username)}>
                              <Fingerprint className="size-4" />
                              Unlock with passkey
                            </Button>
                          )}
                          <Input
                            type="password"
                            placeholder="Password"
                            autoFocus={!hasVault(user.username)}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                          />
                          {!hasVault(user.username) && passkeysAvailable() && (
                            <div className="flex items-center gap-2 py-2 text-sm">
                              <Switch id="remember-with-passkey" checked={rememberWithPasskey} onCheckedChange={setRememberWithPasskey} />
                              <Label htmlFor="remember-with-passkey" className="font-normal">
                                Remember on this device
                              </Label>
                            </div>
                          )}
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
    </div>
  );
}
