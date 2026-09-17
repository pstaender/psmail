import { AttachmentList } from "./AttachmentList";
import { MessageBody } from "./MessageBody";
import { MessageHeader } from "./MessageHeader";
import { MessageToolbar } from "./MessageToolbar";
import type { EmailRecord } from "../../server/types";
import type { FolderInfo } from "@/lib/api";

export function MessageView({
  accountEmail,
  email,
  folders,
  onReply,
  onForward,
  onDelete,
  onMove,
  onToggleRead,
}: {
  accountEmail: string;
  email: EmailRecord;
  folders: FolderInfo[];
  onReply: () => void;
  onForward: () => void;
  onDelete: () => void;
  onMove: (folder: string) => void;
  onToggleRead: () => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <MessageToolbar
        email={email}
        folders={folders}
        onReply={onReply}
        onForward={onForward}
        onDelete={onDelete}
        onMove={onMove}
        onToggleRead={onToggleRead}
      />
      <MessageHeader email={email} />
      <AttachmentList accountEmail={accountEmail} emailId={email.id} attachments={email.attachments ?? []} />
      <div className="flex-1 overflow-y-auto">
        <MessageBody email={email} />
      </div>
    </div>
  );
}
