import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { UserSettings } from "@/lib/api";

const MAX_INTERVAL_MINUTES = 24 * 60;

/** Per-user preferences, stored on the server (so they follow the user across browsers). */
export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  username,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: UserSettings;
  username: string | null;
  onSave: (patch: { syncIntervalMinutes: number | null; combinedInboxIncludesFolders: boolean }) => Promise<void>;
}) {
  const [interval, setInterval] = useState("");
  const [includeFolders, setIncludeFolders] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seeded from the stored settings each time the dialog opens.
  useEffect(() => {
    if (open) {
      setInterval(settings.syncIntervalMinutes ? String(settings.syncIntervalMinutes) : "");
      setIncludeFolders(settings.combinedInboxIncludesFolders === true);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = interval.trim();
    let minutes: number | null = null;
    if (trimmed !== "") {
      minutes = Number(trimmed);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_INTERVAL_MINUTES) {
        setError(`Sync interval must be a whole number of minutes between 1 and ${MAX_INTERVAL_MINUTES}, or empty for never.`);
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      await onSave({ syncIntervalMinutes: minutes, combinedInboxIncludesFolders: includeFolders });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>{username && username !== "default" ? `For ${username}` : "Your preferences"}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} noValidate className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="space-y-1.5">
            <Label htmlFor="settings-sync-interval">Sync interval (minutes)</Label>
            <Input
              id="settings-sync-interval"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_INTERVAL_MINUTES}
              className="w-28"
              placeholder="never"
              value={interval}
              onChange={e => setInterval(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              While P.S.Mail is open in your browser, all accounts are synced this often. Leave empty to only sync
              when you click "Sync now".
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-md border p-3">
            <Switch
              id="settings-inbox-folders"
              className="mt-0.5"
              checked={includeFolders}
              onCheckedChange={setIncludeFolders}
            />
            <div className="space-y-0.5">
              <Label htmlFor="settings-inbox-folders">Show mail from folders in the combined Inbox</Label>
              <p className="text-xs text-muted-foreground">
                The combined Inbox then also lists (and counts unread in) each account's other folders, except Sent,
                Drafts, Trash, Junk and Archive.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
