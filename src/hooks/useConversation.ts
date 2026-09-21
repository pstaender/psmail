import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { Conversation } from "../server/models/conversations";

/** The conversation of the open message (what it answers and what answers it), fetched when the message is opened. */
export function useConversation(accountEmail: string | null, emailId: number | null, enabled = true): Conversation | null {
  const { token } = useAuth();
  const [conversation, setConversation] = useState<{ emailId: number; data: Conversation } | null>(null);

  useEffect(() => {
    if (!enabled || !token || !accountEmail || emailId === null) {
      setConversation(null);
      return;
    }
    let cancelled = false;
    api
      .getConversation(token, accountEmail, emailId)
      .then(data => !cancelled && setConversation({ emailId, data }))
      .catch(() => !cancelled && setConversation(null)); // a conversation is a nicety: without it the message reads as before
    return () => {
      cancelled = true;
    };
  }, [token, accountEmail, emailId, enabled]);

  // Never show the previous message's conversation for the newly opened one.
  return conversation && conversation.emailId === emailId ? conversation.data : null;
}
