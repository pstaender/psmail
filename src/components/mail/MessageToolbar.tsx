import { useEffect, useState } from "react";
import { FolderInput, Forward, Mail, PenSquare, Reply, ReplyAll, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import type { EmailRecord } from "../../server/types";
import type { FolderInfo } from "@/lib/api";

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
}) {
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
