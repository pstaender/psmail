import { useEffect, useState } from "react";
import { FolderInput, Forward, Languages, Mail, PenSquare, Reply, ReplyAll, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import type { EmailRecord } from "../../server/types";
import type { FolderInfo } from "@/lib/api";
import type { AiSkillRecord } from "../../server/models/ai";
import { AiSkillButton } from "./AiSkillButton";

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
  onToggleRead,
  onEditDraft,
  aiSkills,
  aiBusy,
  onSummarize,
  onTranslate,
}: {
  email: EmailRecord;
  folders: FolderInfo[];
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onDelete: () => void;
  onMove: (folder: string) => void;
  onToggleRead: () => void;
  onEditDraft: () => void;
  /** The user's AI skills: Summarize/Translate are only shown for categories that have one (set up in Settings → AI), and offer a choice when there are several. */
  aiSkills: AiSkillRecord[];
  aiBusy: "summarize" | "translate" | null;
  onSummarize: (skillId: number) => void;
  onTranslate: (skillId: number) => void;
}) {
  const summarizers = aiSkills.filter(skill => skill.category === "summarize");
  const translators = aiSkills.filter(skill => skill.category === "translate");
  // "Reply all" only appears once the pointer or keyboard focus reaches "Reply", so it can't be hit by accident
  // (it messes up more people than a plain reply). It then stays for the rest of this message.
  const [replyAllShown, setReplyAllShown] = useState(false);
  useEffect(() => setReplyAllShown(false), [email.id]);

  return (
    <div className="flex items-center gap-1 border-b px-3 py-1.5">
      <Button
        variant="ghost"
        size="sm"
        onClick={onReply}
        onMouseEnter={() => setReplyAllShown(true)}
        onFocus={() => setReplyAllShown(true)}
      >
        <Reply className="size-4" /> Reply
      </Button>
      {replyAllShown && (
        <Button variant="ghost" size="sm" onClick={onReplyAll}>
          <ReplyAll className="size-4" /> Reply all
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onForward}>
        <Forward className="size-4" /> Forward
      </Button>

      {/* The AI buttons only exist for skills the user has set up — nobody who doesn't want AI is nudged to. */}
      {(summarizers.length > 0 || translators.length > 0) && (
        <>
          <Separator orientation="vertical" className="mx-1 h-5" />

          <AiSkillButton
            skills={summarizers}
            busy={aiBusy === "summarize"}
            icon={<Sparkles className="size-4" />}
            label="Summarize"
            title="Summarize (and categorize) this message with AI"
            onRun={onSummarize}
          />
          <AiSkillButton
            skills={translators}
            busy={aiBusy === "translate"}
            icon={<Languages className="size-4" />}
            label="Translate"
            title="Translate this message with AI"
            onRun={onTranslate}
          />
        </>
      )}

      <Separator orientation="vertical" className="mx-1 h-5" />

      <Button variant="ghost" size="sm" onClick={onToggleRead}>
        <Mail className="size-4" /> Mark {email.isRead ? "unread" : "read"}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">
            <FolderInput className="size-4" /> Move
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {folders
            .filter(f => f.path !== email.folder)
            .map(f => (
              <DropdownMenuItem key={f.path} onClick={() => onMove(f.path)}>
                {f.name}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="ghost" size="sm" onClick={onDelete}>
        <Trash2 className="size-4" /> Delete
      </Button>

      {email.isDraft && (
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onEditDraft}>
          <PenSquare className="size-4" /> Edit draft
        </Button>
      )}
    </div>
  );
}
