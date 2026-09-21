import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { hasVault, removeVault } from "@/lib/passkeyVault";

/**
 * The sign-in name of the profile. Renaming changes only that: same password, same accounts, same mail. The one thing tied to the old
 * name is the passkey unlock stored in this browser (it is bound to the name), which is removed and can be set up again at the next
 * sign-in.
 */
export function UsernameForm() {
  const { token, username, renameUser } = useAuth();
  const [name, setName] = useState(username ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const changed = trimmed !== "" && trimmed !== username;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !username || !changed) return;
    setBusy(true);
    setError(null);
    try {
      const user = await api.changeUsername(token, trimmed);
      const hadVault = hasVault(username);
      if (hadVault) removeVault(username);
      renameUser(user.username);
      setName(user.username);
      toast.success(`Your username is now "${user.username}".${hadVault ? " The passkey unlock for the old name was removed; set it up again at your next sign-in." : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-2">
      <div className="space-y-1.5">
        <Label htmlFor="settings-username">Username</Label>
        <div className="flex gap-2">
          <Input id="settings-username" autoComplete="username" maxLength={64} value={name} onChange={e => setName(e.target.value)} />
          <Button type="submit" variant="outline" disabled={busy || !changed}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Rename
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">The name you pick your profile with when signing in. Nothing else changes.</p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
