import { useState } from "react";
import { FolderInput, Forward, Mail, Reply, Trash2 } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import type { EmailRecord } from "../../server/types";
import type { FolderInfo } from "@/lib/api";

export function MessageToolbar({
  email,
  folders,
  onReply,
  onForward,
  onDelete,
  onMove,
  onToggleRead,
}: {
  email: EmailRecord;
  folders: FolderInfo[];
  onReply: () => void;
  onForward: () => void;
  onDelete: () => void;
  onMove: (folder: string) => void;
  onToggleRead: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="flex items-center gap-1 border-b px-3 py-1.5">
      <Button variant="ghost" size="sm" onClick={onReply}>
        <Reply className="size-4" /> Reply
      </Button>
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

      <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
        <Trash2 className="size-4" /> Delete
      </Button>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this message?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes it from P.S.Mail's local database. It is not (yet) deleted on the mail server.
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
