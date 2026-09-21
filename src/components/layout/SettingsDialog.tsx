import { useEffect, useState } from "react";
import { Loader2, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AiSettings } from "./AiSettings";
import { PasswordForm } from "./PasswordForm";
import type { UserSettings } from "@/lib/api";
import { DEFAULT_NOTIFICATION_SOUND, NOTIFICATION_SOUNDS, playNotificationSound } from "@/lib/notifications";

const MAX_INTERVAL_MINUTES = 24 * 60;

export interface SettingsPatch {
  syncIntervalMinutes: number | null;
  combinedInboxIncludesFolders: boolean;
  imboxEnabled: boolean;
  notifyBrowser: boolean;
  notifyToast: boolean;
  notificationSound: NonNullable<UserSettings["notificationSound"]>;
}

/** Per-user preferences, stored on the server (so they follow the user across browsers). */
export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  username,
  onSave,
  onSaveLanguage,
  onAiChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: UserSettings;
  username: string | null;
  onSave: (patch: SettingsPatch) => Promise<void>;
  /** Saves the language the Translate skill translates into (null = back to the default). */
  onSaveLanguage: (language: string | null) => Promise<void>;
  /** The AI providers/skills changed — the app re-reads which skills exist. */
  onAiChanged: () => void;
}) {
  const [interval, setInterval] = useState("");
  const [includeFolders, setIncludeFolders] = useState(false);
  const [imboxEnabled, setImboxEnabled] = useState(false);
  const [notifyBrowser, setNotifyBrowser] = useState(false);
  const [notifyToast, setNotifyToast] = useState(false);
  const [sound, setSound] = useState<SettingsPatch["notificationSound"]>(DEFAULT_NOTIFICATION_SOUND);
  const [tab, setTab] = useState("inboxes");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seeded from the stored settings each time the dialog opens.
  useEffect(() => {
    if (open) {
      setInterval(settings.syncIntervalMinutes ? String(settings.syncIntervalMinutes) : "");
      setIncludeFolders(settings.combinedInboxIncludesFolders === true);
      setImboxEnabled(settings.imboxEnabled === true);
      setNotifyBrowser(settings.notifyBrowser === true);
      setNotifyToast(settings.notifyToast === true);
      setSound(settings.notificationSound ?? DEFAULT_NOTIFICATION_SOUND);
      setError(null);
      setTab("inboxes");
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

    // Turning browser notifications on needs the browser's permission, which can only be asked for from
    // a user action like this click — and if it isn't granted, the option can't work, so don't save it.
    if (notifyBrowser && settings.notifyBrowser !== true) {
      if (typeof Notification === "undefined") {
        setError("This browser doesn't support notifications.");
        return;
      }
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission !== "granted") {
        setError("The browser blocked notifications for this site. Allow them in the browser's site settings, then try again.");
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      await onSave({ syncIntervalMinutes: minutes, combinedInboxIncludesFolders: includeFolders, imboxEnabled, notifyBrowser, notifyToast, notificationSound: sound });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[90vh] overflow-y-auto", tab === "ai" ? "sm:max-w-2xl" : "sm:max-w-md")}>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>{username && username !== "default" ? `For ${username}` : "Your preferences"}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab} className="gap-4">
          <TabsList>
            <TabsTrigger value="inboxes">Inboxes</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            <TabsTrigger value="ai">AI</TabsTrigger>
            <TabsTrigger value="credentials">Credentials</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "credentials" ? (
          <PasswordForm />
        ) : tab === "ai" ? (
          <AiSettings settings={settings} onSaveLanguage={onSaveLanguage} onChanged={onAiChanged} />
        ) : (
          <form onSubmit={submit} noValidate className="space-y-4">
            {error && <p className="text-sm text-destructive">{error}</p>}

            {tab === "inboxes" ? (
              <>
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
              While P.S.Mail is open in your browser, each account's Inbox is synced this often (other folders only
              when you click "Sync now"). Leave empty to never sync automatically.
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

          <div className="flex items-start gap-2 rounded-md border p-3">
            <Switch id="settings-imbox" className="mt-0.5" checked={imboxEnabled} onCheckedChange={setImboxEnabled} />
            <div className="space-y-0.5">
              <Label htmlFor="settings-imbox">Enable imbox</Label>
              <p className="text-xs text-muted-foreground">
                Adds an <strong>Imbox</strong> between the combined Inbox and Sent: only the important mail — from people you know, replies
                to you, mail meant for you — without newsletters, one-time codes, activity notifications and suspected spam. It is sorted
                out on this computer, no AI service is involved. New mail is classified as it arrives; to classify the mail you already
                have, run <code>bun run cli imbox classify</code> (add an account address to do just that account).
              </p>
            </div>
          </div>

              </>
            ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-2">
              <Switch id="settings-notify-browser" className="mt-0.5" checked={notifyBrowser} onCheckedChange={setNotifyBrowser} />
              <div className="space-y-0.5">
                <Label htmlFor="settings-notify-browser">Browser notification</Label>
                <p className="text-xs text-muted-foreground">
                  A desktop notification with the sender and subject (no content) — or a count when several arrive.
                  Clicking it opens the message, or the combined Inbox. Your browser will ask for permission.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <Switch id="settings-notify-toast" className="mt-0.5" checked={notifyToast} onCheckedChange={setNotifyToast} />
              <div className="space-y-0.5">
                <Label htmlFor="settings-notify-toast">Toast in the app</Label>
                <p className="text-xs text-muted-foreground">
                  A message in the corner with the sender, subject, the start of the text, date and recipients, and a
                  sound.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 pl-10">
              <Label htmlFor="settings-sound" className="shrink-0 text-xs text-muted-foreground">
                Toast sound
              </Label>
              <select
                id="settings-sound"
                value={sound}
                onChange={e => setSound(e.target.value as SettingsPatch["notificationSound"])}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {NOTIFICATION_SOUNDS.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <Button type="button" variant="ghost" size="icon" className="size-8" title="Play sound" onClick={() => playNotificationSound(sound)}>
                <Volume2 className="size-4" />
              </Button>
            </div>
          </div>

            )}

          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
