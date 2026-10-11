import { useEffect, useRef, useState } from "react";
import { ImageDown, Languages, Loader2, Paperclip, Send as SendIcon, Sparkles, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RecipientInput } from "./RecipientInput";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { api, type FolderInfo } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { parseAddressList } from "@/lib/addresses";
import { cleanSubject, joinRefined, replaceRefined, splitRefinable } from "@/lib/compose";
import { resolveSpecialFolder } from "@/lib/folders";
import { canOfferAvif, convertToAvif } from "@/lib/avif";
import { toast } from "sonner";
import type { AiCategory } from "../../ai/categories";
import type { AiSkillRecord } from "../../server/models/ai";
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
  /** A forward only: the message being forwarded — once this is sent, that message is marked as forwarded. */
  forwardOf?: { accountEmail: string; id: number };
  /** The draft's attachments already on the server, when editing — shown alongside newly-added files, removable individually. */
  attachments?: AttachmentRecord[];
  /** A forward only: the original message's own (non-inline) attachments, offered via a checkbox — not yet copied onto the draft. */
  forwardAttachments?: AttachmentRecord[];
}

export function ComposeDialog({
  accountEmail,
  senderName,
  folders,
  open,
  onOpenChange,
  initial,
  onSent,
  aiSkills = [],
  aiLanguage = "English",
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
  /** The user's AI skills — the Refine button and its items exist only for those, one entry per skill when a category has several. */
  aiSkills?: AiSkillRecord[];
  /** The language Translate starts with (the user's setting). */
  aiLanguage?: string;
}) {
  const { token } = useAuth();
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<AttachmentRecord[]>([]);
  const [includeForwardAttachments, setIncludeForwardAttachments] = useState(true);
  const [busy, setBusy] = useState<"draft" | "send" | null>(null);
  // Newly attached PNGs / larger JPEGs: offered for converting to AVIF (see addFiles), then converted in place in `files`.
  const [avifOffer, setAvifOffer] = useState<File[]>([]);
  const [converting, setConverting] = useState(false);
  const convertRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);

  const isEditing = initial?.id !== undefined;

  // Changes that are not saved: what the fields hold now against what the dialog was opened with. (An attachment removed from
  // an existing draft is already gone on the server, so it isn't a pending change; a file added is.) Line endings and trailing
  // blank lines are ignored, so an editor that tidies the text on load doesn't make an untouched draft look edited.
  const same = (a: string, b: string) => a.replace(/\r\n?/g, "\n").trimEnd() === b.replace(/\r\n?/g, "\n").trimEnd();
  const dirty =
    !same(to, initial?.to ?? "") ||
    !same(cc, initial?.cc ?? "") ||
    !same(bcc, initial?.bcc ?? "") ||
    !same(subject, initial?.subject ?? "") ||
    !same(body, initial?.body ?? "") ||
    files.length > 0;
  const [askingToClose, setAskingToClose] = useState(false);
  const discardRef = useRef<HTMLButtonElement>(null);

  /** Every way of closing the window (Esc, the x, a click outside) comes through here: with unsaved changes it asks first. */
  function requestClose(next: boolean) {
    if (!next && dirty && busy === null) setAskingToClose(true);
    else onOpenChange(next);
  }
  // "Refine" (AI): rewrites what is selected in the subject or the message — or, with nothing selected, the part of the draft
  // you wrote (not the signature or the quoted original), and then writes a subject line if there is none yet. The text from
  // before is kept so it can be undone.
  const [refining, setRefining] = useState<AiCategory | null>(null);
  const [beforeRefine, setBeforeRefine] = useState<{ body: string; subject: string } | null>(null);
  const [translateTo, setTranslateTo] = useState<string | null>(null);
  // Which translation skill the language box belongs to (when the user has several).
  const [translateSkillId, setTranslateSkillId] = useState<number | undefined>(undefined);
  // The field (subject or message) the user was in last, so its selection is what Refine works on — the Refine menu and the
  // language box take the focus but don't count; any other field (To, Cc, …) means "no selection".
  const lastFieldRef = useRef<"subject" | "body" | null>(null);
  const skillsOf = (category: AiCategory) => aiSkills.filter(skill => skill.category === category);

  function trackField(e: React.FocusEvent) {
    const target = e.target as HTMLElement;
    if (target === subjectRef.current) lastFieldRef.current = "subject";
    else if (target.closest(".psmail-markdown-editor")) lastFieldRef.current = "body";
    else if (target.closest("[data-refine-ui]")) return;
    else if (target.matches("input, textarea, [contenteditable]")) lastFieldRef.current = null;
  }

  /** What is selected in the field the user was in last: the subject's or the message's selection, as offsets; null if nothing. */
  function selection(): { field: "subject" | "body"; start: number; end: number } | null {
    if (lastFieldRef.current === "subject") {
      const input = subjectRef.current;
      const [start, end] = [input?.selectionStart ?? 0, input?.selectionEnd ?? 0];
      return start < end && subject.slice(start, end).trim() ? { field: "subject", start, end } : null;
    }
    if (lastFieldRef.current === "body") {
      const range = editorRef.current?.getSelectedRange();
      return range && body.slice(range.start, range.end).trim() ? { field: "body", ...range } : null;
    }
    return null;
  }

  function applyRefined(next: { body: string; subject: string }) {
    setBeforeRefine({ body, subject });
    if (next.body !== body) {
      editorRef.current?.setContent(next.body);
      setBody(next.body);
    }
    setSubject(next.subject);
  }

  async function refine(category: "improve" | "grammar" | "translate", language?: string, skillId?: number) {
    if (!token) return;
    const selected = selection();
    const parts = splitRefinable(body);
    if (!selected && !parts.head.trim()) {
      setError("Write something first — there is no text to refine yet.");
      return;
    }
    setRefining(category);
    setError(null);
    try {
      if (selected) {
        const text = selected.field === "subject" ? subject : body;
        const result = await api.aiRun(token, category, text.slice(selected.start, selected.end).trim(), language, skillId);
        const next = replaceRefined(text, selected.start, selected.end, result.text);
        // A subject is one line, whatever the AI answered.
        applyRefined(selected.field === "subject" ? { body, subject: next.replace(/\s*\n\s*/g, " ") } : { body: next, subject });
      } else {
        const result = await api.aiRun(token, category, parts.head.trim(), language, skillId);
        const nextBody = joinRefined(parts, result.text);
        // The whole text refined and no subject yet: write one from it (if there is a skill for that). If that fails, the
        // refined text is kept anyway.
        let nextSubject = subject;
        if (!subject.trim() && skillsOf("subject").length > 0) {
          setRefining("subject");
          try {
            nextSubject = cleanSubject((await api.aiRun(token, "subject", splitRefinable(nextBody).head.trim())).text);
          } catch (err) {
            setError(`The text was refined, but no subject line could be written: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        applyRefined({ body: nextBody, subject: nextSubject });
      }
      setTranslateTo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefining(null);
    }
  }

  /** Writes a subject line from the part of the draft you wrote, replacing the subject there is. */
  async function createSubject(skillId: number) {
    if (!token) return;
    const text = splitRefinable(body).head.trim();
    if (!text) {
      setError("Write something first — the subject line is made from your text.");
      return;
    }
    setRefining("subject");
    setError(null);
    try {
      applyRefined({ body, subject: cleanSubject((await api.aiRun(token, "subject", text, undefined, skillId)).text) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefining(null);
    }
  }

  function undoRefine() {
    if (beforeRefine === null) return;
    if (beforeRefine.body !== body) {
      editorRef.current?.setContent(beforeRefine.body);
      setBody(beforeRefine.body);
    }
    setSubject(beforeRefine.subject);
    setBeforeRefine(null);
  }

  useEffect(() => {
    if (open) {
      setTo(initial?.to ?? "");
      setCc(initial?.cc ?? "");
      setBcc(initial?.bcc ?? "");
      setShowCc(!!initial?.cc || !!initial?.bcc);
      setSubject(initial?.subject ?? "");
      setBody(initial?.body ?? "");
      setFiles([]);
      setAvifOffer([]);
      setExistingAttachments(initial?.attachments ?? []);
      setIncludeForwardAttachments(true);
      setError(null);
      setBeforeRefine(null);
      setTranslateTo(null);
      lastFieldRef.current = null;
      setAskingToClose(false);
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

  function addFiles(added: File[]) {
    setFiles(prev => [...prev, ...added]);
    const candidates = added.filter(canOfferAvif);
    if (candidates.length > 0) setAvifOffer(candidates);
  }

  /** Replaces each offered image in `files` by its AVIF version (unless that wouldn't be smaller), one at a time. */
  async function convertOffered() {
    const candidates = avifOffer;
    setAvifOffer([]);
    setConverting(true);
    let before = 0;
    let after = 0;
    try {
      for (const original of candidates) {
        // The encode blocks the main thread — let the "Converting…" state paint first.
        await new Promise(resolve => setTimeout(resolve, 16));
        const converted = await convertToAvif(original);
        before += original.size;
        after += converted.size;
        setFiles(prev => prev.map(file => (file === original ? converted : file)));
      }
      toast.success(`Images converted to AVIF: ${formatSizeMB(before)} → ${formatSizeMB(after)}`);
    } catch (err) {
      setError(`Could not convert to AVIF, the original kept: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConverting(false);
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
        // Without this the draft's date stays null (it only otherwise gets one from actually being
        // sent, or synced from IMAP) — which pushed it to the very end of the Drafts list (NULL
        // sorts last in `ORDER BY date DESC`) instead of near the top, by when it was last saved.
        date: new Date().toISOString(),
      };

      const draft: EmailRecord = isEditing
        ? await api.updateEmail(token, accountEmail, initial!.id!, payload)
        : await api.createDraft(token, accountEmail, payload);

      for (const file of files) {
        await api.uploadAttachment(token, accountEmail, draft.id, file);
      }

      if (includeForwardAttachments && initial?.forwardOf && initial.forwardAttachments) {
        for (const attachment of initial.forwardAttachments) {
          await api.copyAttachment(token, accountEmail, draft.id, initial.forwardOf.id, attachment.id);
        }
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
    <Dialog open={open} onOpenChange={requestClose}>
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

        <div className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1" onFocus={trackField}>
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
            <Input id="compose-subject" ref={subjectRef} value={subject} onChange={e => setSubject(e.target.value)} />
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

          <div className="flex flex-wrap items-center gap-2 empty:hidden">
            {/* Only for skills that exist: no Refine at all without any, and one entry per skill (named) when a category has several. */}
            {aiSkills.some(skill => ["improve", "grammar", "translate", "subject"].includes(skill.category)) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-refine-ui
                    disabled={refining !== null || busy !== null}
                    title="Refines the selected text (in the subject or the message), or the whole text when nothing is selected"
                  >
                    {refining ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    Refine
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {(
                    [
                      ["improve", "Phrase"],
                      ["grammar", "Spelling + Grammar"],
                    ] as const
                  ).flatMap(([category, title]) =>
                    skillsOf(category).map((skill, _, all) => (
                      <DropdownMenuItem key={skill.id} onSelect={() => refine(category, undefined, skill.id)}>
                        {all.length > 1 ? `${title} · ${skill.name}` : title}
                      </DropdownMenuItem>
                    ))
                  )}
                  {skillsOf("translate").map((skill, _, all) => (
                    <DropdownMenuItem
                      key={skill.id}
                      onSelect={() => {
                        setTranslateSkillId(skill.id);
                        setTranslateTo(aiLanguage);
                      }}
                    >
                      {all.length > 1 ? `Translate… · ${skill.name}` : "Translate…"}
                    </DropdownMenuItem>
                  ))}
                  {skillsOf("subject").map((skill, _, all) => (
                    <DropdownMenuItem key={skill.id} onSelect={() => createSubject(skill.id)}>
                      {all.length > 1 ? `Subject line · ${skill.name}` : "Subject line"}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {translateTo !== null && (
              <form
                data-refine-ui
                className="flex items-center gap-1.5"
                onSubmit={e => {
                  e.preventDefault();
                  if (translateTo.trim()) refine("translate", translateTo.trim(), translateSkillId);
                }}
              >
                <Languages className="size-3.5 text-muted-foreground" />
                <Input aria-label="Translate into" className="h-8 w-40" value={translateTo} onChange={e => setTranslateTo(e.target.value)} placeholder="Language" autoFocus />
                <Button type="submit" size="sm" disabled={refining !== null || !translateTo.trim()}>
                  Translate
                </Button>
                <Button type="button" variant="ghost" size="icon" className="size-7" title="Cancel translating" onClick={() => setTranslateTo(null)}>
                  <X className="size-3.5" />
                </Button>
              </form>
            )}
            {beforeRefine !== null && (
              <Button type="button" variant="ghost" size="sm" onClick={undoRefine}>
                <Undo2 className="size-3.5" /> Undo
              </Button>
            )}
          </div>

          {!!initial?.forwardAttachments?.length && (
            <div className="space-y-1.5">
              <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox checked={includeForwardAttachments} onCheckedChange={checked => setIncludeForwardAttachments(checked === true)} />
                Include {initial.forwardAttachments.length === 1 ? "the original message's attachment" : `all ${initial.forwardAttachments.length} attachments from the original message`}
              </label>
              <div className={`flex flex-wrap gap-2 ${includeForwardAttachments ? "" : "opacity-50"}`}>
                {initial.forwardAttachments.map(attachment => (
                  <span key={attachment.id} className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
                    <Paperclip className="size-3" />
                    {attachment.filename}
                    <span className="text-muted-foreground">{formatSizeMB(attachment.size)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

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
            {converting ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Converting images to AVIF…
              </span>
            ) : (
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                <Paperclip className="size-3.5" />
                Attach files
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={e => {
                    addFiles(Array.from(e.target.files ?? []));
                    e.target.value = ""; // so picking the same file again (after removing it) still fires onChange
                  }}
                />
              </label>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy !== null || converting} onClick={() => saveAndMaybeSend(false)}>
            {busy === "draft" && <Loader2 className="size-4 animate-spin" />}
            Save draft
          </Button>
          <Button disabled={busy !== null || converting} onClick={() => saveAndMaybeSend(true)}>
            {busy === "send" ? <Loader2 className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>

      <AlertDialog open={avifOffer.length > 0} onOpenChange={next => !next && setAvifOffer([])}>
        <AlertDialogContent
          // Converting is the default, Enter does it.
          onOpenAutoFocus={e => {
            e.preventDefault();
            convertRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{avifOffer.length === 1 ? "Convert the image to AVIF?" : `Convert ${avifOffer.length} images to AVIF?`}</AlertDialogTitle>
            <AlertDialogDescription>
              AVIF files are usually much smaller than PNG or JPEG at a similar quality, so the message is quicker to send and to
              download. Most current mail apps and browsers show them; some older ones don't.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-wrap gap-2">
            {avifOffer.map((file, i) => (
              <span key={i} className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
                <Paperclip className="size-3" />
                {file.name}
                <span className="text-muted-foreground">{formatSizeMB(file.size)}</span>
              </span>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep originals</AlertDialogCancel>
            <Button ref={convertRef} onClick={convertOffered}>
              <ImageDown className="size-4" /> Convert to AVIF
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={askingToClose} onOpenChange={setAskingToClose}>
        <AlertDialogContent
          // Discarding is the default: it is what closing a window usually means, and Enter does it.
          onOpenAutoFocus={e => {
            e.preventDefault();
            discardRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{isEditing ? "Save the changes to this draft?" : "Save this message as a draft?"}</AlertDialogTitle>
            <AlertDialogDescription>You have made changes that are not saved yet.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                setAskingToClose(false);
                saveAndMaybeSend(false); // closes the window when it worked; on an error it stays open and says why
              }}
            >
              Save draft
            </Button>
            <Button
              ref={discardRef}
              onClick={() => {
                setAskingToClose(false);
                onOpenChange(false);
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
