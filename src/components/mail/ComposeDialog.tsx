import { useEffect, useState } from "react";
import { Loader2, Paperclip, Send as SendIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { parseAddressList } from "@/lib/addresses";
import type { EmailRecord } from "../../server/types";

export interface ComposeDraft {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  inReplyTo?: string | null;
}

export function ComposeDialog({
  accountEmail,
  open,
  onOpenChange,
  initial,
  onSent,
}: {
  accountEmail: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ComposeDraft | null;
  onSent: () => void;
}) {
  const { token } = useAuth();
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTo(initial?.to ?? "");
      setCc(initial?.cc ?? "");
      setShowCc(!!initial?.cc);
      setSubject(initial?.subject ?? "");
      setBody(initial?.body ?? "");
      setFiles([]);
      setError(null);
    }
  }, [open, initial]);

  async function saveAndMaybeSend(send: boolean) {
    if (!token) return;
    setBusy(send ? "send" : "draft");
    setError(null);
    try {
      const draft: EmailRecord = await api.createDraft(token, accountEmail, {
        from: [{ address: accountEmail }],
        to: parseAddressList(to),
        cc: parseAddressList(cc),
        subject,
        plainText: body,
        inReplyTo: initial?.inReplyTo ?? null,
      });

      for (const file of files) {
        await api.uploadAttachment(token, accountEmail, draft.id, file);
      }

      if (send) {
        await api.sendEmail(token, accountEmail, draft.id);
      }

      onSent();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="space-y-1.5">
            <Label htmlFor="compose-from">From</Label>
            <Input id="compose-from" value={accountEmail} disabled />
          </div>

          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="compose-to">To</Label>
              <Input id="compose-to" value={to} onChange={e => setTo(e.target.value)} placeholder="name@example.com" />
            </div>
            {!showCc && (
              <Button type="button" variant="link" size="sm" onClick={() => setShowCc(true)}>
                Cc
              </Button>
            )}
          </div>

          {showCc && (
            <div className="space-y-1.5">
              <Label htmlFor="compose-cc">Cc</Label>
              <Input id="compose-cc" value={cc} onChange={e => setCc(e.target.value)} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="compose-subject">Subject</Label>
            <Input id="compose-subject" value={subject} onChange={e => setSubject(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="compose-body">Message</Label>
            <Textarea id="compose-body" rows={10} value={body} onChange={e => setBody(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-2">
              {files.map((file, i) => (
                <span key={i} className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
                  <Paperclip className="size-3" />
                  {file.name}
                  <button type="button" onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <Paperclip className="size-3.5" />
              Attach files
              <input
                type="file"
                multiple
                className="hidden"
                onChange={e => setFiles(prev => [...prev, ...Array.from(e.target.files ?? [])])}
              />
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy !== null} onClick={() => saveAndMaybeSend(false)}>
            {busy === "draft" && <Loader2 className="size-4 animate-spin" />}
            Save draft
          </Button>
          <Button disabled={busy !== null} onClick={() => saveAndMaybeSend(true)}>
            {busy === "send" ? <Loader2 className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
