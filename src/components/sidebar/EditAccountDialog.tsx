import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownEditor, type MarkdownEditorHandle } from "@/components/mail/MarkdownEditor";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { Account } from "../../server/types";
import type { UpdateAccountInput } from "../../server/models/accounts";

interface EditForm {
  displayName: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  imapPassword: string; // blank = keep the existing password unchanged
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string; // blank = keep the existing password unchanged
  readOnly: boolean;
  skipSoftDelete: boolean;
  senderName: string;
  signature: string;
}

const EMPTY: EditForm = {
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
  readOnly: false,
  skipSoftDelete: false,
  senderName: "",
  signature: "",
};

function formFromAccount(account: Account): EditForm {
  return {
    displayName: account.displayName ?? "",
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapSecure: account.imapSecure,
    imapUsername: account.imapUsername,
    imapPassword: "",
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure,
    smtpUsername: account.smtpUsername,
    smtpPassword: "",
    readOnly: account.readOnly,
    skipSoftDelete: account.skipSoftDelete,
    senderName: account.senderName ?? "",
    signature: account.signature ?? "",
  };
}

/**
 * Editing an account's connection details/password/safety flags/signature, not creating a new
 * one. Always mounted (rendered unconditionally from AppShell with `open` toggling visibility,
 * like the delete-account confirmation) rather than conditionally, so Radix's close transition
 * can play out; the form is (re-)seeded from `account` via effect whenever a new one is opened,
 * matching ComposeDialog's approach — not lazy initial state, since this one component instance
 * is reused across edits of different accounts, not remounted per account. The signature
 * MarkdownEditor doesn't need its own remount handling for that same reason: Radix's Dialog
 * unmounts its content entirely while closed, so it (like ComposeDialog's) always mounts fresh
 * with the just-reseeded value the next time this dialog opens.
 */
export function EditAccountDialog({
  account,
  open,
  onOpenChange,
  onSaved,
}: {
  account: Account | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { token } = useAuth();
  const [form, setForm] = useState<EditForm>(EMPTY);
  const [activeTab, setActiveTab] = useState("server");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingCapabilities, setCheckingCapabilities] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const signatureEditorRef = useRef<MarkdownEditorHandle>(null);

  useEffect(() => {
    if (open && account) {
      setForm(formFromAccount(account));
      setError(null);
      setCapabilitiesError(null);
    }
  }, [open, account]);

  // Separate from the effect above, and keyed only on `open`: resetting the active tab should
  // happen when the dialog actually opens, not on every re-render while it stays open — e.g.
  // checkCapabilities() below calls onSaved(), which refetches accounts and gives this a new
  // `account` object reference without the dialog ever closing, and that must not yank the
  // user back to the Server tab away from the Safety tab they were just looking at.
  useEffect(() => {
    if (open) setActiveTab("server");
  }, [open]);

  function set<K extends keyof EditForm>(key: K, value: EditForm[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function checkCapabilities() {
    if (!token || !account) return;
    setCheckingCapabilities(true);
    setCapabilitiesError(null);
    try {
      await api.checkImapCapabilities(token, account.email);
      onSaved(); // refetches the account list, so `account.supportsUidPlus` reflects the fresh result
    } catch (err) {
      setCapabilitiesError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingCapabilities(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !account) return;
    setBusy(true);
    setError(null);
    try {
      const patch: UpdateAccountInput = {
        displayName: form.displayName,
        imapHost: form.imapHost,
        imapPort: form.imapPort,
        imapSecure: form.imapSecure,
        imapUsername: form.imapUsername,
        smtpHost: form.smtpHost,
        smtpPort: form.smtpPort,
        smtpSecure: form.smtpSecure,
        smtpUsername: form.smtpUsername,
        readOnly: form.readOnly,
        skipSoftDelete: form.skipSoftDelete,
        senderName: form.senderName,
        signature: form.signature,
      };
      if (form.imapPassword) patch.imapPassword = form.imapPassword;
      if (form.smtpPassword) patch.smtpPassword = form.smtpPassword;

      await api.updateAccount(token, account.email, patch);
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Account settings</DialogTitle>
          <DialogDescription>{account?.email}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}

          <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-4">
            <TabsList>
              <TabsTrigger value="server">Server</TabsTrigger>
              <TabsTrigger value="safety">Safety</TabsTrigger>
              <TabsTrigger value="signature">Signature</TabsTrigger>
            </TabsList>

            <TabsContent value="server" className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="edit-acc-name">Display name (optional)</Label>
                <Input id="edit-acc-name" value={form.displayName} onChange={e => set("displayName", e.target.value)} />
              </div>

              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">IMAP (incoming)</legend>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-1.5">
                    <Label htmlFor="edit-imap-host">Host</Label>
                    <Input
                      id="edit-imap-host"
                      required
                      value={form.imapHost}
                      onChange={e => set("imapHost", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-imap-port">Port</Label>
                    <Input
                      id="edit-imap-port"
                      type="number"
                      required
                      value={form.imapPort}
                      onChange={e => set("imapPort", Number(e.target.value))}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-imap-user">Username</Label>
                  <Input
                    id="edit-imap-user"
                    required
                    value={form.imapUsername}
                    onChange={e => set("imapUsername", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-imap-pass">Password</Label>
                  <Input
                    id="edit-imap-pass"
                    type="password"
                    placeholder="Leave blank to keep current password"
                    value={form.imapPassword}
                    onChange={e => set("imapPassword", e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="edit-imap-secure" checked={form.imapSecure} onCheckedChange={v => set("imapSecure", v)} />
                  <Label htmlFor="edit-imap-secure">Use TLS</Label>
                </div>
              </fieldset>

              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">SMTP (outgoing)</legend>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-1.5">
                    <Label htmlFor="edit-smtp-host">Host</Label>
                    <Input
                      id="edit-smtp-host"
                      required
                      value={form.smtpHost}
                      onChange={e => set("smtpHost", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="edit-smtp-port">Port</Label>
                    <Input
                      id="edit-smtp-port"
                      type="number"
                      required
                      value={form.smtpPort}
                      onChange={e => set("smtpPort", Number(e.target.value))}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-smtp-user">Username</Label>
                  <Input
                    id="edit-smtp-user"
                    required
                    value={form.smtpUsername}
                    onChange={e => set("smtpUsername", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-smtp-pass">Password</Label>
                  <Input
                    id="edit-smtp-pass"
                    type="password"
                    placeholder="Leave blank to keep current password"
                    value={form.smtpPassword}
                    onChange={e => set("smtpPassword", e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="edit-smtp-secure" checked={form.smtpSecure} onCheckedChange={v => set("smtpSecure", v)} />
                  <Label htmlFor="edit-smtp-secure">Use TLS</Label>
                </div>
              </fieldset>
            </TabsContent>

            <TabsContent value="safety" className="space-y-4">
              <div className="flex items-start gap-2 rounded-md border p-3">
                <Switch
                  id="edit-read-only"
                  className="mt-0.5"
                  checked={form.readOnly}
                  onCheckedChange={v => set("readOnly", v)}
                />
                <div className="space-y-0.5">
                  <Label htmlFor="edit-read-only">Read-only</Label>
                  <p className="text-xs text-muted-foreground">
                    Local changes (flags, moves, deletes) are never uploaded to this account's IMAP server.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-md border p-3">
                <Switch
                  id="edit-skip-soft-delete"
                  className="mt-0.5"
                  checked={form.skipSoftDelete}
                  onCheckedChange={v => set("skipSoftDelete", v)}
                />
                <div className="flex-1 space-y-1">
                  <Label htmlFor="edit-skip-soft-delete">Always delete permanently</Label>
                  <p className="text-xs text-muted-foreground">
                    By default, Delete moves a message to Trash first instead of erasing it right away. Turn this on
                    to skip Trash and always expunge immediately.
                  </p>

                  {account?.supportsUidPlus === true && (
                    <p className="text-xs text-muted-foreground">
                      This server supports UIDPLUS, so moving to Trash first is available.
                    </p>
                  )}
                  {account?.supportsUidPlus === false && (
                    <p className="text-xs text-amber-600">
                      Soft-delete isn't available on this server: it doesn't support the UIDPLUS extension, so moving
                      a message to Trash can't be done without risking other deleted messages too. Delete always
                      expunges permanently until it does.
                    </p>
                  )}
                  {account?.supportsUidPlus === null && (
                    <p className="text-xs text-muted-foreground">
                      Server capability not checked yet — Delete expunges permanently until it is.
                    </p>
                  )}

                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={checkCapabilities}
                    disabled={checkingCapabilities}
                  >
                    {checkingCapabilities && <Loader2 className="size-3 animate-spin" />}
                    Check server capabilities
                  </Button>
                  {capabilitiesError && <p className="text-xs text-destructive">{capabilitiesError}</p>}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="signature" className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-sender-name">Sender name</Label>
                <Input
                  id="edit-sender-name"
                  placeholder="e.g. Alice Example"
                  value={form.senderName}
                  onChange={e => set("senderName", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Shown as the From name on outgoing mail, instead of the bare address.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="cursor-pointer" onClick={() => signatureEditorRef.current?.focus()}>
                  Signature
                </Label>
                <div className="rounded-md border border-input bg-transparent px-3 py-2 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
                  <MarkdownEditor
                    ref={signatureEditorRef}
                    initialValue={form.signature}
                    onChange={value => set("signature", value)}
                    placeholder="Optional — appended to new messages, replies, and forwards"
                    aria-label="Signature"
                    className="min-h-[8rem]"
                  />
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
