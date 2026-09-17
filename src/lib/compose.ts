import { formatAddressList } from "./addresses";
import { formatFullDate } from "./time";
import type { EmailRecord } from "../server/types";
import type { ComposeDraft } from "@/components/mail/ComposeDialog";

export function replyDraft(email: EmailRecord): ComposeDraft {
  const replyTo = email.replyTo.length > 0 ? email.replyTo : email.from;
  const subject = /^re:/i.test(email.subject ?? "") ? email.subject! : `Re: ${email.subject ?? ""}`;
  const quotedBody = (email.plainText ?? "")
    .split("\n")
    .map(line => `> ${line}`)
    .join("\n");

  return {
    to: formatAddressList(replyTo),
    subject,
    body: `\n\nOn ${formatFullDate(email.date)}, ${formatAddressList(email.from)} wrote:\n${quotedBody}`,
    inReplyTo: email.messageId,
  };
}

export function forwardDraft(email: EmailRecord): ComposeDraft {
  const subject = /^fwd:/i.test(email.subject ?? "") ? email.subject! : `Fwd: ${email.subject ?? ""}`;
  const header = [
    "\n\n---------- Forwarded message ----------",
    `From: ${formatAddressList(email.from)}`,
    `Date: ${formatFullDate(email.date)}`,
    `Subject: ${email.subject ?? ""}`,
    `To: ${formatAddressList(email.to)}`,
    "",
    email.plainText ?? "",
  ].join("\n");

  return { to: "", subject, body: header };
}
