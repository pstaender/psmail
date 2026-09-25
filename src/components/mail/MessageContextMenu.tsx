import { Reply, ReplyAll, Forward, Star, Trash2, FolderInput, Mail, MailOpen } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { FolderInfo } from "@/lib/api";
import { modKey } from "@/lib/platform";

/**
 * Right-click menu for a message-list row. The actions it offers (reply, mark read/unread, delete, move, ...)
 * all act on the app's single "open" message, so opening the menu first selects this row the same way a plain
 * click would (`onOpen`) — by the time a menu item is actually chosen, that selection has already landed.
 */
export function MessageContextMenu({
  children,
  isRead,
  isFlagged,
  folder,
  folders,
  onOpen,
  onReply,
  onReplyAll,
  onForward,
  onToggleFlag,
  onToggleRead,
  onDelete,
  onMove,
}: {
  children: React.ReactNode;
  isRead: boolean;
  isFlagged: boolean;
  /** This message's current folder, so it isn't offered as a "move to" target. */
  folder: string;
  folders: FolderInfo[];
  onOpen: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onToggleFlag: () => void;
  onToggleRead: () => void;
  onDelete: () => void;
  onMove: (folder: string) => void;
}) {
  const moveTargets = folders.filter(f => f.path !== folder);
  return (
    <ContextMenu
      onOpenChange={open => {
        if (open) onOpen();
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={onReply}>
          <Reply /> Reply
          <ContextMenuShortcut>{modKey("R")}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onReplyAll}>
          <ReplyAll /> Reply all
        </ContextMenuItem>
        <ContextMenuItem onSelect={onForward}>
          <Forward /> Forward
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onToggleFlag}>
          <Star className={isFlagged ? "fill-yellow-400 text-yellow-500" : undefined} />
          {isFlagged ? "Unstar" : "Star"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onToggleRead}>
          {isRead ? <Mail /> : <MailOpen />}
          Mark as {isRead ? "unread" : "read"}
        </ContextMenuItem>
        {moveTargets.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FolderInput /> Move to folder
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {moveTargets.map(f => (
                <ContextMenuItem key={f.path} onSelect={() => onMove(f.path)}>
                  {f.path.toUpperCase() === "INBOX" ? "Inbox" : f.path}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 /> Delete
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
