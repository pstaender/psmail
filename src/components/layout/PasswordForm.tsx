import { useState } from "react";
import { Fingerprint, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { addPasskey, hasVault, listPasskeys, passkeysAvailable, removePasskey, removeVault } from "@/lib/passkeyVault";

/**
 * Changing the login password. The server re-encrypts the saved IMAP/SMTP passwords of every account
 * under the new password's key in the same step, so nothing has to be re-entered afterwards. The
 * current password is required (also to prove it's really the user); other browsers' sessions are ended.
 * An empty new password is allowed (it makes the profile passwordless, like the built-in default one).
 */
export function PasswordForm() {
  const { token, username } = useAuth();
  // Passkey unlock on this device (set up at sign-in): shown here so it can be removed, and it goes away with a password change.
  const [passkeys, setPasskeys] = useState(() => (username ? listPasskeys(username) : []));
  const [addingPasskey, setAddingPasskey] = useState(false);
  const vaultPresent = passkeys.length > 0;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    if (next !== confirm) {
      setError("The new password and its confirmation don't match.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { otherSessionsSignedOut } = await api.changePassword(token, current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      // What the passkey protects is the old password: it would only fail from now on.
      const hadVault = !!username && hasVault(username);
      if (username) removeVault(username);
      setPasskeys([]);
      const others =
        otherSessionsSignedOut > 0 ? ` ${otherSessionsSignedOut} other session${otherSessionsSignedOut === 1 ? " was" : "s were"} signed out.` : "";
      toast.success(`${next === "" ? "Password removed." : "Password changed."}${others}${hadVault ? " Passkey unlock was removed from this device; set it up again at your next sign-in." : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="space-y-1.5">
        <Label htmlFor="settings-current-password">Current password</Label>
        <Input
          id="settings-current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={e => setCurrent(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">Leave empty if your profile has no password yet.</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="settings-new-password">New password</Label>
        <Input id="settings-new-password" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
        <p className="text-xs text-muted-foreground">Leave both new-password fields empty to remove the password (anyone who can reach this app can then sign in to your profile).</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="settings-confirm-password">Confirm new password</Label>
        <Input
          id="settings-confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        The saved passwords of your mail accounts are encrypted with a key derived from this password, so they are
        re-encrypted for the new one automatically. You stay signed in here; your other browsers are signed out.
      </p>

      {vaultPresent && username && (
        <div className="space-y-2 rounded-md border p-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Fingerprint className="size-4 shrink-0" />
            <span className="flex-1">
              Passkey unlock is set up on this device: the sign-in screen can unlock your saved password with any of these passkeys.
            </span>
          </div>
          <ul className="space-y-1">
            {passkeys.map((passkey, index) => (
              <li key={passkey.credentialId} className="flex items-center gap-2 pl-6">
                <span className="flex-1 text-foreground">
                  Passkey {index + 1}
                  <span className="text-muted-foreground">
                    {passkey.addedAt ? ` · added ${new Date(passkey.addedAt).toLocaleDateString()}` : ""}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  title={`Remove passkey ${index + 1}`}
                  onClick={() => {
                    removePasskey(username, passkey.credentialId);
                    setPasskeys(listPasskeys(username));
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {passkeysAvailable() && (
            <div className="pl-6">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={addingPasskey}
                title="Add another passkey (a second device's authenticator or a backup security key)"
                onClick={async () => {
                  setAddingPasskey(true);
                  setError(null);
                  try {
                    await addPasskey(username); // unlocks with an existing passkey first, then registers the new one
                    setPasskeys(listPasskeys(username));
                    toast.success("Another passkey was added.");
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setAddingPasskey(false);
                  }
                }}
              >
                {addingPasskey ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                Add another passkey
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          Change password
        </Button>
      </div>
    </form>
  );
}
