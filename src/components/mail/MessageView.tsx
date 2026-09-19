import { AttachmentList } from "./AttachmentList";
import { MessageBody, type BodyView } from "./MessageBody";
import { MessageHeader } from "./MessageHeader";
import { MessageToolbar } from "./MessageToolbar";
import type { EmailRecord } from "../../server/types";
import type { FolderInfo } from "@/lib/api";
import type { AiCategory } from "../../ai/categories";

export function MessageView({
  accountEmail,
  email,
  folders,
  preferredView,
  onViewChange,
  onReply,
  onReplyAll,
  onForward,
  onDelete,
  onMove,
  onToggleRead,
  onEditDraft,
  aiCategories,
  aiBusy,
  onSummarize,
  onTranslate,
}: {
  accountEmail: string;
  email: EmailRecord;
  folders: FolderInfo[];
  preferredView: BodyView | null;
  onViewChange: (view: BodyView) => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onDelete: () => void;
  onMove: (folder: string) => void;
  onToggleRead: () => void;
  onEditDraft: () => void;
  aiCategories: Set<AiCategory>;
  aiBusy: "summarize" | "translate" | null;
  onSummarize: () => void;
  onTranslate: () => void;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <MessageToolbar
        email={email}
        folders={folders}
        onReply={onReply}
        onReplyAll={onReplyAll}
        onForward={onForward}
        onDelete={onDelete}
        onMove={onMove}
        onToggleRead={onToggleRead}
        onEditDraft={onEditDraft}
        aiCategories={aiCategories}
        aiBusy={aiBusy}
        onSummarize={onSummarize}
        onTranslate={onTranslate}
      />
      <MessageHeader email={email} />
      <AttachmentList accountEmail={accountEmail} emailId={email.id} attachments={email.attachments ?? []} />
      <div className="flex-1 overflow-y-auto">
        <MessageBody
          email={email}
          preferredView={preferredView}
          onViewChange={onViewChange}
          canSummarize={aiCategories.has("summarize")}
          summarizing={aiBusy === "summarize"}
          onSummarize={onSummarize}
        />
      </div>
    </div>
  );
}
