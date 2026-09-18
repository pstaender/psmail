import { useState } from "react";
import { FolderInput, Mail, MailOpen, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { FolderInfo } from "@/lib/api";

/** Toolbar shown instead of the folder header once one or more messages are checked (Cmd/Ctrl+click). */
export function BulkActionBar({
  count,
  folders,
  onMarkRead,
  onMarkUnread,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  folders: FolderInfo[];
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onMove: (folder: string) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="flex items-center justify-between gap-2 border-b bg-accent/40 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" className="size-7" onClick={onClear} title="Clear selection">
          <X className="size-4" />
        </Button>
        <span className="text-sm font-medium">{count} selected</span>
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onMarkRead} title="Mark as read">
          <MailOpen className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={onMarkUnread} title="Mark as unread">
          <Mail className="size-4" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" title="Move">
              <FolderInput className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {folders.map(f => (
              <DropdownMenuItem key={f.path} onClick={() => onMove(f.path)}>
                {f.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} title="Delete">
          <Trash2 className="size-4" />
        </Button>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {count} message{count === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This also deletes {count === 1 ? "it" : "them"} from the account's mail server, unless the account is
              read-only — moved to Trash first if the server supports that safely, or permanently otherwise.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
