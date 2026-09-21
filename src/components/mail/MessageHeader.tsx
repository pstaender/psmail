import { useEffect, useState } from "react";
import { ChevronDown, Forward, MailCheck, Reply, Sparkles, Star } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useUiSettings } from "@/contexts/UiSettingsContext";
import type { ConversationMessage } from "../../server/models/conversations";
import { formatFullDate } from "@/lib/time";
import type { EmailAddress, EmailRecord } from "../../server/types";

function formatAddress(addr: EmailAddress): string {
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

/**
 * One header line (From, To, Cc, ...). Long recipient lists wrap onto several lines but stop after three
 * (about 4rem) with an ellipsis, so a mail sent to a whole mailing list doesn't push the message off screen;
 * `full` shows all of it.
 */
function AddressLine({ label, addresses, full }: { label: string; addresses: EmailAddress[]; full: boolean }) {
  if (addresses.length === 0) return null;
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 flex-1 break-words", !full && "line-clamp-3 max-h-16 overflow-hidden")}>
        {addresses.map(formatAddress).join(", ")}
      </span>
    </div>
  );
}

export function MessageHeader({
  email,
  summarizing = false,
  imboxEnabled = false,
  imboxDisabled = false,
  onMarkImbox = () => {},
  replyMessage = null,
  onOpenReply = () => {},
}: {
  email: EmailRecord;
  /** A summary is being generated for this message (started from the Summary tab). */
  summarizing?: boolean;
  /** The imbox is on: a small mark beside the subject says whether the message counts as important, and flips it. */
  imboxEnabled?: boolean;
  imboxDisabled?: boolean;
  onMarkImbox?: (important: boolean) => void;
  /** The user's answer to this message, when there is one: a small "replied" icon beside the subject opens it. */
  replyMessage?: ConversationMessage | null;
  onOpenReply?: (message: ConversationMessage) => void;
}) {
  const { showConversations } = useUiSettings();
  const [expanded, setExpanded] = useState(false);
  // "Expand all details": Cc/Bcc (and To) unclamped, plus the message id, which is hidden otherwise.
  const [allDetails, setAllDetails] = useState(false);
  useEffect(() => setAllDetails(false), [email.id]);
  const from = email.from[0];

  return (
    <div className="space-y-3 border-b p-4">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold leading-tight">{email.subject || "(no subject)"}</h2>
        <div className="flex shrink-0 items-center gap-1">
          {/* Subtle on purpose: a quiet icon that is lit while the message is in the Imbox. Clicking it is the user telling the imbox
              what it got wrong — for this message and, from now on, for this sender. */}
          {imboxEnabled && !email.isDraft && (
            <button
              type="button"
              disabled={imboxDisabled}
              aria-pressed={email.imbox === true}
              aria-label={email.imbox ? "In the Imbox — mark as not important" : "Not in the Imbox — mark as important"}
              title={
                email.imbox
                  ? "Important (in the Imbox). Click to mark it, and mail from this sender, as not important."
                  : "Not in the Imbox. Click to mark it, and mail from this sender, as important."
              }
              onClick={() => onMarkImbox(email.imbox !== true)}
              className={cn(
                "mt-0.5 rounded p-0.5 transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40",
                email.imbox ? "text-primary" : "text-muted-foreground/40 hover:text-muted-foreground"
              )}
            >
              <MailCheck className="size-4" />
            </button>
          )}
          {replyMessage && (
            <button
              type="button"
              aria-label="You replied — see your reply"
              title="You replied to this message. Click to see your reply."
              onClick={() => onOpenReply(replyMessage)}
              className="mt-0.5 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Reply className="size-4" />
            </button>
          )}
          {showConversations && email.isForwarded && (
            <span className="mt-0.5 p-0.5 text-muted-foreground/60" title="You forwarded this message">
              <Forward aria-label="Forwarded" className="size-4" />
            </span>
          )}
          {email.isFlagged && <Star aria-label="Starred" className="mt-1 size-4 shrink-0 fill-yellow-400 text-yellow-500" />}
        </div>
      </div>

      {summarizing && !email.aiSummary && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 animate-pulse" /> Generating the summary… this may take a moment.
        </p>
      )}

      <div className="flex items-start gap-3">
        <Avatar className="size-9 shrink-0">
          <AvatarFallback>{(from?.name || from?.address || "?").slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium">{from ? formatAddress(from) : "(unknown sender)"}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatFullDate(email.date)}</span>
          </div>

          <Collapsible open={expanded} onOpenChange={setExpanded}>
            <CollapsibleTrigger className="flex w-full items-center justify-start gap-1 text-left text-xs text-muted-foreground hover:text-foreground">
              to {email.to.map(a => a.name || a.address).join(", ") || "—"}
              <ChevronDown className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")} />
            </CollapsibleTrigger>

            <CollapsibleContent>
              <div className="mt-1 space-y-1 rounded-md bg-muted/40 p-2">
                <AddressLine label="From" addresses={email.from} full={allDetails} />
                <AddressLine label="To" addresses={email.to} full={allDetails} />
                <AddressLine label="Cc" addresses={email.cc} full={allDetails} />
                <AddressLine label="Bcc" addresses={email.bcc} full={allDetails} />
                <AddressLine label="Reply-To" addresses={email.replyTo} full={allDetails} />

                {/* More than the above (whole recipient lists, the message id): just an arrow says there is more. */}
                <Collapsible open={allDetails} onOpenChange={setAllDetails}>
                  <CollapsibleContent>
                    {email.messageId && (
                      <div className="flex gap-2 text-sm">
                        <span className="w-14 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">{email.messageId}</span>
                      </div>
                    )}
                  </CollapsibleContent>
                  <CollapsibleTrigger
                    aria-label={allDetails ? "Collapse details" : "Expand all details"}
                    title={allDetails ? "Collapse details" : "Expand all details"}
                    className="mx-auto flex items-center justify-center rounded text-muted-foreground/80 hover:text-foreground"
                  >
                    <ChevronDown className={cn("size-4 transition-transform", allDetails && "rotate-180")} />
                  </CollapsibleTrigger>
                </Collapsible>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </div>
  );
}
