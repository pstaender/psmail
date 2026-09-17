import { Download, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { AttachmentRecord } from "../../server/types";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentList({
  accountEmail,
  emailId,
  attachments,
}: {
  accountEmail: string;
  emailId: number;
  attachments: AttachmentRecord[];
}) {
  const { token } = useAuth();
  if (attachments.length === 0 || !token) return null;

  return (
    <div className="flex flex-wrap gap-2 border-b bg-muted/20 px-4 py-3">
      {attachments.map(attachment => (
        <button
          key={attachment.id}
          onClick={() => api.downloadAttachment(token, accountEmail, emailId, attachment.id, attachment.filename)}
          className="group flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs hover:bg-accent"
        >
          <Paperclip className="size-3.5 text-muted-foreground" />
          <span className="max-w-40 truncate">{attachment.filename}</span>
          <span className="text-muted-foreground">{formatSize(attachment.size)}</span>
          <Download className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      ))}
    </div>
  );
}
