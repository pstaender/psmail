import { useEffect, useRef, useState } from "react";
import { Loader2, Paperclip, Send as SendIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RecipientInput } from "./RecipientInput";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { api, type FolderInfo } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { parseAddressList } from "@/lib/addresses";
import { resolveSpecialFolder } from "@/lib/folders";
import type { AttachmentRecord, EmailRecord } from "../../server/types";

function formatSizeMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface ComposeDraft {
  /** Present when editing an existing draft in place (see editDraft in lib/compose.ts) — saving updates that same row instead of creating a new one. */
  id?: number;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  /** Reply/forward only: the quoted original that `body` ends with — lets the signature be inserted before it (see withSignature). */
  quoted?: string;
  inReplyTo?: string | null;
  /** The draft's attachments already on the server, when editing — shown alongside newly-added files, removable individually. */
  attachments?: AttachmentRecord[];
}

export function ComposeDialog({
  accountEmail,
  senderName,
  folders,
  open,
  onOpenChange,
  initial,
  onSent,
}: {
  accountEmail: string;
  /** Used as the From display name on outgoing mail, instead of the bare address. */
  senderName: string | null;
  /** The account's live IMAP folder list — used to find the real Drafts folder path (see saveAndMaybeSend). */
  folders: FolderInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ComposeDraft | null;
  /** `sent` is true when the draft was actually sent, false when it was just saved. */
  onSent: (sent: boolean) => void;
}) {
  const { token } = useAuth();
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<AttachmentRecord[]>([]);
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isEditing = initial?.id !== undefined;

  useEffect(() => {
    if (open) {
      setTo(initial?.to ?? "");
      setCc(initial?.cc ?? "");
      setBcc(initial?.bcc ?? "");
      setShowCc(!!initial?.cc || !!initial?.bcc);
      setSubject(initial?.subject ?? "");
      setBody(initial?.body ?? "");
      setFiles([]);
      setExistingAttachments(initial?.attachments ?? []);
      setError(null);
    }
  }, [open, initial]);

  async function removeExistingAttachment(attachmentId: number) {
    if (!token || initial?.id === undefined) return;
    try {
      await api.deleteAttachment(token, accountEmail, initial.id, attachmentId);
      setExistingAttachments(prev => prev.filter(a => a.id !== attachmentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveAndMaybeSend(send: boolean) {
    if (!token) return;
    setBusy(send ? "send" : "draft");
    setError(null);
    try {
      const payload = {
        // Not every server literally names it "Drafts" (some use a localized name, e.g.
        // "Entwürfe") — without this, the draft could be saved under a folder path that never
        // matches anything in the live IMAP folder list, making it look like it vanished.
        folder: resolveSpecialFolder(folders, "\\Drafts", "Drafts"),
        from: [senderName ? { address: accountEmail, name: senderName } : { address: accountEmail }],
        to: parseAddressList(to),
        cc: parseAddressList(cc),
        bcc: parseAddressList(bcc),
        subject,
        plainText: body,
        inReplyTo: initial?.inReplyTo ?? null,
      };

      const draft: EmailRecord = isEditing
        ? await api.updateEmail(token, accountEmail, initial!.id!, payload)
        : await api.createDraft(token, accountEmail, payload);

      for (const file of files) {
        await api.uploadAttachment(token, accountEmail, draft.id, file);
      }

      if (send) {
        await api.sendEmail(token, accountEmail, draft.id);
      }

      onSent(send);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-xl lg:max-w-[50rem]"
        // A reply arrives with the recipient already filled in, so the cursor belongs in the message,
        // not in the To field Radix would focus by default.
        onOpenAutoFocus={e => {
          if (initial?.to) {
            e.preventDefault();
            editorRef.current?.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit draft" : "New message"}</DialogTitle>
        </DialogHeader>

        <div className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1">
          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="space-y-1.5">
            <Label htmlFor="compose-from">From</Label>
            <Input id="compose-from" value={accountEmail} disabled />
          </div>

          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="compose-to">To</Label>
              <RecipientInput id="compose-to" accountEmail={accountEmail} value={to} onChange={setTo} placeholder="name@example.com" />
            </div>
            {!showCc && (
              <Button type="button" variant="link" size="sm" onClick={() => setShowCc(true)}>
                Cc/Bcc
              </Button>
            )}
          </div>

          {showCc && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="compose-cc">Cc</Label>
                <RecipientInput id="compose-cc" accountEmail={accountEmail} value={cc} onChange={setCc} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="compose-bcc">Bcc</Label>
                <RecipientInput id="compose-bcc" accountEmail={accountEmail} value={bcc} onChange={setBcc} />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="compose-subject">Subject</Label>
            <Input id="compose-subject" value={subject} onChange={e => setSubject(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label className="cursor-pointer" onClick={() => editorRef.current?.focus()}>
              Message
            </Label>
            <div className="rounded-md border border-input bg-transparent px-3 py-2 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
              <MarkdownEditor
                ref={editorRef}
                initialValue={body}
                onChange={setBody}
                placeholder="Write your message…"
                aria-label="Message"
                className="min-h-[12rem]"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-2">
              {existingAttachments.map(attachment => (
                <span key={attachment.id} className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
                  <Paperclip className="size-3" />
                  {attachment.filename}
                  <span className="text-muted-foreground">{formatSizeMB(attachment.size)}</span>
                  <button type="button" onClick={() => removeExistingAttachment(attachment.id)}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {files.map((file, i) => (
                <span key={i} className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
                  <Paperclip className="size-3" />
                  {file.name}
                  <span className="text-muted-foreground">{formatSizeMB(file.size)}</span>
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
