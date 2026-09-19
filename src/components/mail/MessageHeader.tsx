import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Star } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
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

export function MessageHeader({ email }: { email: EmailRecord }) {
  const [expanded, setExpanded] = useState(false);
  // "Expand all details": Cc/Bcc (and To) unclamped, plus the Message-ID, which is hidden otherwise.
  const [allDetails, setAllDetails] = useState(false);
  useEffect(() => setAllDetails(false), [email.id]);
  const from = email.from[0];

  return (
    <div className="space-y-3 border-b p-4">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold leading-tight">{email.subject || "(no subject)"}</h2>
        {email.isFlagged && <Star aria-label="Starred" className="mt-1 size-4 shrink-0 fill-yellow-400 text-yellow-500" />}
      </div>

      <div className="flex items-start gap-3">
        <Avatar className="size-9 shrink-0">
          <AvatarFallback>{(from?.name || from?.address || "?").slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium">{from ? formatAddress(from) : "(unknown sender)"}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatFullDate(email.date)}</span>
          </div>

          <button
            onClick={() => setExpanded(v => !v)}
            className="flex w-full items-center justify-start gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            to {email.to.map(a => a.name || a.address).join(", ") || "—"}
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>

          {expanded && (
            <div className="space-y-1 rounded-md bg-muted/40 p-2">
              <AddressLine label="From" addresses={email.from} full={allDetails} />
              <AddressLine label="To" addresses={email.to} full={allDetails} />
              <AddressLine label="Cc" addresses={email.cc} full={allDetails} />
              <AddressLine label="Bcc" addresses={email.bcc} full={allDetails} />
              <AddressLine label="Reply-To" addresses={email.replyTo} full={allDetails} />
              {allDetails && email.messageId && (
                <div className="flex gap-2 text-sm">
                  <span className="w-14 shrink-0 text-muted-foreground">Message-ID</span>
                  <span className="min-w-0 flex-1 break-all font-mono text-xs">{email.messageId}</span>
                </div>
              )}
              <button
                onClick={() => setAllDetails(v => !v)}
                className="text-xs text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
              >
                {allDetails ? "Collapse details" : "Expand all details"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
