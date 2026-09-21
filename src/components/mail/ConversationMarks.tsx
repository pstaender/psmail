import { Forward, MessagesSquare, Reply } from "lucide-react";

/**
 * Small, quiet icons at the end of a list row's subject: the message is part of a conversation (with how many related messages
 * the mailbox has), the user has replied to it, and/or it was forwarded. Nothing for a message that is none of these.
 */
export function ConversationMarks({ conversation }: { conversation?: { replied: boolean; forwarded?: boolean; related: number } }) {
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
      {conversation.forwarded && (
        <span className="shrink-0" title="Forwarded">
          <Forward aria-label="Forwarded" className="size-3.5 text-muted-foreground/70" />
        </span>
      )}
    </>
  );
}
