import { formatAddressList } from "./addresses";
import { formatFullDate } from "./time";
import type { EmailAddress, EmailRecord } from "../server/types";
import type { ComposeDraft } from "@/components/mail/ComposeDialog";

function dedupeAddresses(addresses: EmailAddress[], exclude: Set<string>): EmailAddress[] {
  const seen = new Set(exclude);
  return addresses.filter(a => {
    const key = a.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function replyDraft(email: EmailRecord): ComposeDraft {
  const replyTo = email.replyTo.length > 0 ? email.replyTo : email.from;
  const subject = /^re:/i.test(email.subject ?? "") ? email.subject! : `Re: ${email.subject ?? ""}`;
  const quotedBody = (email.plainText ?? "")
    .split("\n")
    .map(line => `> ${line}`)
    .join("\n");

  const quoted = `On ${formatFullDate(email.date)}, ${formatAddressList(email.from)} wrote:\n${quotedBody}`;

  return {
    to: formatAddressList(replyTo),
    subject,
    body: `\n\n${quoted}`,
    quoted,
    inReplyTo: email.messageId,
  };
}

/**
 * Reply to everyone: the sender (or Reply-To) and the original To recipients go in To, the original Cc
 * recipients in Cc — minus the account's own address and any duplicates (an address already in To isn't
 * repeated in Cc). Subject, quote and threading are the same as a plain reply.
 */
export function replyAllDraft(email: EmailRecord, ownAddress: string): ComposeDraft {
  const own = new Set([ownAddress.toLowerCase()]);
  const to = dedupeAddresses([...(email.replyTo.length > 0 ? email.replyTo : email.from), ...email.to], own);
  const cc = dedupeAddresses(email.cc, new Set([...own, ...to.map(a => a.address.toLowerCase())]));
  return { ...replyDraft(email), to: formatAddressList(to), cc: formatAddressList(cc) };
}

export function forwardDraft(email: EmailRecord): ComposeDraft {
  const subject = /^fwd:/i.test(email.subject ?? "") ? email.subject! : `Fwd: ${email.subject ?? ""}`;
  const quoted = [
    "---------- Forwarded message ----------",
    `From: ${formatAddressList(email.from)}`,
    `Date: ${formatFullDate(email.date)}`,
    `Subject: ${email.subject ?? ""}`,
    `To: ${formatAddressList(email.to)}`,
    "",
    email.plainText ?? "",
  ].join("\n");

  return { to: "", subject, body: `\n\n${quoted}`, quoted };
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
 * Adds the account's signature to a fresh composition's body (after it for a new message, before the quoted original for a reply/forward) — only meant for a brand new
 * message, reply, or forward, never for editDraft's result (that body is already the draft's
 * own finalized content; re-appending a signature to it on every edit would just keep piling
 * up copies).
 */
export function withSignature(draft: ComposeDraft | null, signature: string | null): ComposeDraft {
  if (!signature) return draft ?? {};
  // Reply/forward: the signature goes between the (empty) place you type your answer and the quoted
  // original, not below the quote.
  if (draft?.quoted !== undefined) return { ...draft, body: `\n\n-- \n${signature}\n\n${draft.quoted}` };
  const body = draft?.body ? `${draft.body}\n\n-- \n${signature}` : `\n\n-- \n${signature}`;
  return { ...draft, body };
}

/**
 * Splits a draft into the part you wrote and the tail that must be left alone when refining with AI: the
 * signature ("-- "), the quoted original of a reply ("On … wrote:" / "> …") or a forwarded message. The tail
 * starts at the first such marker; `head` keeps its own leading/trailing whitespace so the text can be put
 * back exactly around the refined version.
 */
export function splitRefinable(body: string): { head: string; tail: string } {
  const marker = /\n(?:-- \n|On [^\n]+ wrote:\n|-{5,} Forwarded message -{5,}|> )/.exec(body);
  const cut = marker ? marker.index : body.length;
  return { head: body.slice(0, cut), tail: body.slice(cut) };
}

/** Puts an AI result back where the written part was, keeping the whitespace around it and the untouched tail. */
export function joinRefined(original: { head: string; tail: string }, refined: string): string {
  const leading = /^\s*/.exec(original.head)![0];
  const trailing = /\s*$/.exec(original.head)![0];
  return `${leading}${refined.trim()}${trailing}${original.tail}`;
}
