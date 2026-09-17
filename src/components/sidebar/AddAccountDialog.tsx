import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { CreateAccountInput } from "../../server/models/accounts";

const EMPTY: CreateAccountInput = {
  email: "",
  displayName: "",
  imapHost: "",
  imapPort: 993,
  imapSecure: true,
  imapUsername: "",
  imapPassword: "",
  smtpHost: "",
  smtpPort: 465,
  smtpSecure: true,
  smtpUsername: "",
  smtpPassword: "",
};

export function AddAccountDialog({ onCreated }: { onCreated: () => void }) {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreateAccountInput>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof CreateAccountInput>(key: K, value: CreateAccountInput[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function useSameForSmtp() {
    setForm(prev => ({
      ...prev,
      smtpHost: prev.imapHost.replace(/^imap\./i, "smtp."),
      smtpUsername: prev.imapUsername,
      smtpPassword: prev.imapPassword,
    }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAccount(token, form);
      setForm(EMPTY);
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start">
          <Plus className="size-4" />
          Add account
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add email account</DialogTitle>
          <DialogDescription>Connect an IMAP/SMTP account. Credentials are encrypted at rest.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5">
          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="acc-email">Email address</Label>
              <Input
                id="acc-email"
                type="email"
                required
                value={form.email}
                onChange={e => set("email", e.target.value)}
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="acc-name">Display name (optional)</Label>
              <Input id="acc-name" value={form.displayName} onChange={e => set("displayName", e.target.value)} />
            </div>
          </div>

          <fieldset className="space-y-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">IMAP (incoming)</legend>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="imap-host">Host</Label>
                <Input id="imap-host" required value={form.imapHost} onChange={e => set("imapHost", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="imap-port">Port</Label>
                <Input
                  id="imap-port"
                  type="number"
                  required
                  value={form.imapPort}
                  onChange={e => set("imapPort", Number(e.target.value))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="imap-user">Username</Label>
              <Input id="imap-user" required value={form.imapUsername} onChange={e => set("imapUsername", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="imap-pass">Password</Label>
              <Input
                id="imap-pass"
                type="password"
                required
                value={form.imapPassword}
                onChange={e => set("imapPassword", e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="imap-secure" checked={form.imapSecure} onCheckedChange={v => set("imapSecure", v)} />
              <Label htmlFor="imap-secure">Use TLS</Label>
            </div>
          </fieldset>

          <fieldset className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between px-1">
              <legend className="text-sm font-medium">SMTP (outgoing)</legend>
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={useSameForSmtp}>
                Copy from IMAP
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="smtp-host">Host</Label>
                <Input id="smtp-host" required value={form.smtpHost} onChange={e => set("smtpHost", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-port">Port</Label>
                <Input
                  id="smtp-port"
                  type="number"
                  required
                  value={form.smtpPort}
                  onChange={e => set("smtpPort", Number(e.target.value))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-user">Username</Label>
              <Input id="smtp-user" required value={form.smtpUsername} onChange={e => set("smtpUsername", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-pass">Password</Label>
              <Input
                id="smtp-pass"
                type="password"
                required
                value={form.smtpPassword}
                onChange={e => set("smtpPassword", e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="smtp-secure" checked={form.smtpSecure} onCheckedChange={v => set("smtpSecure", v)} />
              <Label htmlFor="smtp-secure">Use TLS</Label>
            </div>
          </fieldset>

          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Add account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
