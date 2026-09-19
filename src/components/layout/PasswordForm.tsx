import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Changing the login password. The server re-encrypts the saved IMAP/SMTP passwords of every account
 * under the new password's key in the same step, so nothing has to be re-entered afterwards. The
 * current password is required (also to prove it's really the user); other browsers' sessions are ended.
 */
export function PasswordForm() {
  const { token } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    if (next === "") {
      setError("Enter a new password.");
      return;
    }
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
      toast.success(
        otherSessionsSignedOut > 0
          ? `Password changed. ${otherSessionsSignedOut} other session${otherSessionsSignedOut === 1 ? " was" : "s were"} signed out.`
          : "Password changed."
      );
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

      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          Change password
        </Button>
      </div>
    </form>
  );
}
