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

/** Continues editing an existing draft in place (unlike reply/forward, which always start a new one) — saving updates this same row rather than creating another. */
export function editDraft(email: EmailRecord): ComposeDraft {
  return {
    id: email.id,
    to: formatAddressList(email.to),
    cc: formatAddressList(email.cc),
    bcc: formatAddressList(email.bcc),
    subject: email.subject ?? "",
    body: email.plainText ?? "",
    inReplyTo: email.inReplyTo,
    attachments: email.attachments ?? [],
  };
}

/**
 * Appends the account's signature to a fresh composition's body — only meant for a brand new
 * message, reply, or forward, never for editDraft's result (that body is already the draft's
 * own finalized content; re-appending a signature to it on every edit would just keep piling
 * up copies).
 */
export function withSignature(draft: ComposeDraft | null, signature: string | null): ComposeDraft {
  if (!signature) return draft ?? {};
  const body = draft?.body ? `${draft.body}\n\n-- \n${signature}` : `\n\n-- \n${signature}`;
  return { ...draft, body };
}
