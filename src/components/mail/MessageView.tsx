import { AttachmentList } from "./AttachmentList";
import { MessageBody, type BodyView } from "./MessageBody";
import { MessageHeader } from "./MessageHeader";
import { MessageToolbar } from "./MessageToolbar";
import type { EmailRecord } from "../../server/types";
import type { FolderInfo } from "@/lib/api";
import type { AiSkillRecord } from "../../server/models/ai";

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
  accountDisabled,
  aiSkills = [],
  aiBusy = null,
  onSummarize = () => {},
  onTranslate = () => {},
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
  /** The message's account is disabled: read-only for good — every button that would change something is off. */
  accountDisabled: boolean;
  /** Optional: without AI skills there are no AI buttons or Summary tab. */
  aiSkills?: AiSkillRecord[];
  aiBusy?: "summarize" | "translate" | null;
  onSummarize?: (skillId: number) => void;
  onTranslate?: (skillId: number) => void;
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
        accountDisabled={accountDisabled}
        aiSkills={aiSkills}
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
          summarizeSkills={accountDisabled ? [] : aiSkills.filter(skill => skill.category === "summarize")}
          summarizing={aiBusy === "summarize"}
          onSummarize={onSummarize}
        />
      </div>
    </div>
  );
}
