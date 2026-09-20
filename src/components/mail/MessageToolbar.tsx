import { useEffect, useState } from "react";
import { Download, FolderInput, Forward, Languages, Mail, MoreHorizontal, PenSquare, Reply, ReplyAll, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { EmailRecord } from "../../server/types";
import type { FolderInfo } from "@/lib/api";
import type { AiSkillRecord } from "../../server/models/ai";
import { AiSkillButton } from "./AiSkillButton";
import { FolderCombobox } from "./FolderCombobox";

/** Keyboard focus (Tab) reveals the toolbar; a mouse click that leaves a button focused doesn't keep it open. */
function focusedByKeyboard(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true; // no :focus-visible support: err on the side of showing the actions
  }
}

/**
 * The delete confirmation (skipped entirely when the message would only be soft-deleted, i.e.
 * moved to Trash rather than expunged) is owned by AppShell instead of here, since the same
 * gating/dialog is shared with BulkActionBar's Delete and the Backspace/Delete keyboard
 * shortcut.
 */
export function MessageToolbar({
  email,
  folders,
  onReply,
  onReplyAll,
  onForward,
  onDelete,
  onMove,
  onDownload,
  onToggleRead,
  onEditDraft,
  accountDisabled,
  aiSkills = [],
  aiBusy = null,
  onSummarize = () => {},
  onTranslate = () => {},
}: {
  email: EmailRecord;
  folders: FolderInfo[];
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onDelete: () => void;
  onMove: (folder: string) => void;
  /** Saves the message as an .eml file. Only reads, so it stays available on a disabled account. */
  onDownload: () => void;
  onToggleRead: () => void;
  onEditDraft: () => void;
  /** The account is disabled (frozen): everything that would change it — replying, forwarding, moving, deleting, marking, AI results — is off. Reading stays. */
  accountDisabled: boolean;
  /** The user's AI skills — optional: with none (nobody has to set AI up) there are simply no AI buttons. Translate is only shown for a category that has a skill, and offers a choice when there are several. */
  aiSkills?: AiSkillRecord[];
  aiBusy?: "summarize" | "translate" | null;
  onSummarize?: (skillId: number) => void;
  onTranslate?: (skillId: number) => void;
}) {
  const translators = aiSkills.filter(skill => skill.category === "translate");
  const frozen = accountDisabled ? "This account is disabled" : undefined;
  // "Reply all" only appears once the pointer or keyboard focus reaches "Reply", so it can't be hit by accident
  // (it messes up more people than a plain reply). It then stays for the rest of this message.
  const [replyAllShown, setReplyAllShown] = useState(false);
  useEffect(() => setReplyAllShown(false), [email.id]);

  // The actions stay out of the way so the mail is what you look at: only a small "more" icon shows, and the
  // toolbar appears over the top of the message while the pointer is on that strip, keyboard focus is in it, or the
  // icon was clicked (which is how touch screens, without hover, get to it). It is never unmounted — only faded —
  // so open menus and Tab navigation keep working.
  const [hovering, setHovering] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [pinned, setPinned] = useState(false);
  // An open menu (Move, the AI skills) holds the toolbar open: while it is up the pointer is over the menu, not the
  // strip, and focus is in the menu, so neither would.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    setPinned(false);
    setMenuOpen(false);
  }, [email.id]);
  const open = hovering || focusWithin || pinned || menuOpen;

  return (
    <div
      className="absolute inset-x-0 top-0 z-10 h-9"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={event => setFocusWithin(focusedByKeyboard(event.target as HTMLElement))}
      onBlur={event => setFocusWithin(event.currentTarget.contains(event.relatedTarget as Node | null))}
      onKeyDown={event => {
        if (event.key === "Escape") setPinned(false);
      }}
    >
      <Button
        variant="ghost"
        size="icon"
        className={cn("absolute left-2 text-muted-foreground", open && "opacity-0")}
        title="Message actions"
        aria-label="Message actions"
        aria-expanded={open}
        onClick={() => setPinned(value => !value)}
      >
        {/*<MoreHorizontal className="size-4" />*/}
      </Button>

      <div
        className={cn(
          "absolute inset-x-0 top-0 flex items-center gap-1 bg-background px-3 py-1.5 transition-opacity duration-100",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={() => setPinned(false)}
      >
      <Button
        variant="ghost"
        size="sm"
        disabled={accountDisabled}
        title={frozen}
        onClick={onReply}
        onMouseEnter={() => setReplyAllShown(true)}
        onFocus={() => setReplyAllShown(true)}
      >
        <Reply className="size-4" /> Reply
      </Button>
      {replyAllShown && (
        <Button variant="ghost" size="sm" disabled={accountDisabled} title={frozen} onClick={onReplyAll}>
          <ReplyAll className="size-4" /> Reply all
        </Button>
      )}
      <Button variant="ghost" size="sm" disabled={accountDisabled} title={frozen} onClick={onForward}>
        <Forward className="size-4" /> Forward
      </Button>

      {/* The AI buttons only exist for skills the user has set up — nobody who doesn't want AI is nudged to. */}
      {(translators.length > 0) && (
        <>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <AiSkillButton
            skills={translators}
            busy={aiBusy === "translate"}
            disabled={accountDisabled}
            icon={<Languages className="size-4" />}
            label="Translate"
            title={frozen ?? "Translate this message with AI"}
            onRun={onTranslate}
            onMenuOpenChange={setMenuOpen}
          />
        </>
      )}

      <Separator orientation="vertical" className="mx-1 h-5" />

      <Button variant="ghost" size="sm" disabled={accountDisabled} title={frozen} onClick={onToggleRead}>
        <Mail className="size-4" /> Mark {email.isRead ? "unread" : "read"}
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <Button variant="ghost" size="sm" title="Download this message as an .eml file" onClick={onDownload}>
        <Download className="size-4" /> Download
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <FolderCombobox
        folders={folders.filter(f => f.path !== email.folder)}
        onPick={onMove}
        onOpenChange={setMenuOpen}
        disabled={accountDisabled}
        title={frozen}
      >
        <FolderInput className="size-4" /> Move
      </FolderCombobox>

      <Button variant="ghost" size="sm" disabled={accountDisabled} title={frozen} onClick={onDelete}>
        <Trash2 className="size-4" /> Delete
      </Button>
      </div>

      {email.isDraft && (
        <Button variant="ghost" size="sm" className="absolute right-3 top-0.5 z-20" disabled={accountDisabled} title={frozen} onClick={onEditDraft}>
          <PenSquare className="size-4" /> Edit draft
        </Button>
      )}
    </div>
  );
}
