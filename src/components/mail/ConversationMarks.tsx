import { MessagesSquare, Reply } from "lucide-react";

/**
 * Two small, quiet icons at the end of a list row's subject: the message is part of a conversation (with how many related messages
 * the mailbox has), and/or the user has replied to it. Nothing for a message that is neither.
 */
export function ConversationMarks({ conversation }: { conversation?: { replied: boolean; related: number } }) {
  if (!conversation) return null;
  const related = `${conversation.related} related message${conversation.related === 1 ? "" : "s"}`;
  return (
    <>
      {conversation.related > 0 && (
        <span className="shrink-0" title={`Part of a conversation — ${related}`}>
          <MessagesSquare aria-label="Part of a conversation" className="size-3.5 text-muted-foreground/70" />
        </span>
      )}
      {conversation.replied && (
        <span className="shrink-0" title="You replied">
          <Reply aria-label="You replied" className="size-3.5 text-muted-foreground/70" />
        </span>
      )}
    </>
  );
}
