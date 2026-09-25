import { useState } from "react";
import { ChevronDown, Forward, MessagesSquare, Reply } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatListDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useUiSettings } from "@/contexts/UiSettingsContext";
import type { Conversation, ConversationMessage } from "../../server/models/conversations";

const who = (message: ConversationMessage) => (message.own ? "You" : message.from?.name || message.from?.address || "(unknown)");

/**
 * Under the message header, only for a message that is part of a conversation: one quiet line — "Conversation · 3 messages" — that
 * unfolds into the messages before and after this one (newest first, who wrote each, when, and how it starts; a small arrow marks a forwarded one). A click on one opens it
 * in the reading pane, so the earlier messages of a conversation are one click away, wherever they are (the Inbox, Sent, another
 * account). When the user has answered this message, "See your reply" jumps to the answer.
 */
export function ConversationBar({
  conversation,
  onOpen,
}: {
  conversation: Conversation | null;
  onOpen: (message: ConversationMessage) => void;
}) {
  const { showAbsoluteDates } = useUiSettings();
  const [open, setOpen] = useState(false);
  if (!conversation || conversation.messages.length < 2) return null;

  const { messages, repliedBy } = conversation;
  const reply = repliedBy !== null ? messages.find(message => message.id === repliedBy) : undefined;
  const position = messages.findIndex(message => message.current) + 1;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b bg-muted/20 px-4 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <CollapsibleTrigger className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground" title="Show the conversation">
          <MessagesSquare className="size-3.5" />
          Conversation · {messages.length} messages
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </CollapsibleTrigger>
        <span className="text-muted-foreground/70">(this is {position} of {messages.length})</span>
        {reply && (
          <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-xs" title="Open your reply to this message" onClick={() => onOpen(reply)}>
            <Reply className="size-3.5" /> See your reply
          </Button>
        )}
      </div>

      <CollapsibleContent>
        <ul className="mt-1.5 space-y-0.5 pb-1" aria-label="Messages in this conversation">
          {[...messages].reverse().map(message => (
            <li key={message.id}>
              <button
                type="button"
                aria-current={message.current ? "true" : undefined}
                disabled={message.current}
                onClick={() => onOpen(message)}
                className={cn(
                  "flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-accent disabled:cursor-default",
                  message.current && "bg-accent font-medium",
                  message.own && !message.current && "text-muted-foreground"
                )}
              >
                <span className="w-28 shrink-0 truncate">{who(message)}</span>
                <span className="w-16 shrink-0 text-muted-foreground">{formatListDate(message.date, { forceDate: showAbsoluteDates })}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{message.snippet || message.subject || "(no text)"}</span>
                {message.forwarded && <Forward aria-label="Forwarded" className="size-3 shrink-0 self-center text-muted-foreground/70" />}
                {!message.isRead && !message.own && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
              </button>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
