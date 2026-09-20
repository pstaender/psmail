import { useEffect, useState } from "react";
import { ChevronRight, Download, FolderInput, Forward, Languages, Mail, PenSquare, Reply, ReplyAll, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { EmailRecord } from "../../server/types";
import type { FolderInfo } from "@/lib/api";
import type { AiSkillRecord } from "../../server/models/ai";
import { useLocalStorageState } from "@/hooks/useLocalStorageState";
import { AiSkillButton } from "./AiSkillButton";
import { FolderCombobox } from "./FolderCombobox";

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

  // The actions stay out of the way so the mail is what you look at: a slim strip with just an arrow, which opens
  // the toolbar below it (and closes it again). It starts closed, and stays as the user left it — between messages
  // and between visits.
  const [open, setOpen] = useLocalStorageState("psmail.messageActionsOpen", false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <div className="flex h-8 items-center justify-between px-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" title="Message actions" aria-label="Message actions">
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          </Button>
        </CollapsibleTrigger>

        {/* Editing is what a draft is for, so this one stays in view. */}
        {email.isDraft && (
          <Button variant="ghost" size="sm" disabled={accountDisabled} title={frozen} onClick={onEditDraft}>
            <PenSquare className="size-4" /> Edit draft
          </Button>
        )}
      </div>

      <CollapsibleContent>
        <div className="flex flex-wrap items-center gap-1 px-3 pb-1.5">
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
        disabled={accountDisabled}
        title={frozen}
      >
        <FolderInput className="size-4" /> Move
      </FolderCombobox>

      <Button variant="ghost" size="sm" disabled={accountDisabled} title={frozen} onClick={onDelete}>
        <Trash2 className="size-4" /> Delete
      </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
