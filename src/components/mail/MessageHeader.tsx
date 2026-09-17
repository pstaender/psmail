import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { formatFullDate } from "@/lib/time";
import type { EmailAddress, EmailRecord } from "../../server/types";

function formatAddress(addr: EmailAddress): string {
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

function AddressLine({ label, addresses }: { label: string; addresses: EmailAddress[] }) {
  if (addresses.length === 0) return null;
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate">{addresses.map(formatAddress).join(", ")}</span>
    </div>
  );
}

export function MessageHeader({ email }: { email: EmailRecord }) {
  const [expanded, setExpanded] = useState(false);
  const from = email.from[0];

  return (
    <div className="space-y-3 border-b p-4">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold leading-tight">{email.subject || "(no subject)"}</h2>
        {email.isFlagged && <Badge variant="secondary">Flagged</Badge>}
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
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            to {email.to.map(a => a.name || a.address).join(", ") || "—"}
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>

          {expanded && (
            <div className="space-y-1 rounded-md bg-muted/40 p-2">
              <AddressLine label="From" addresses={email.from} />
              <AddressLine label="To" addresses={email.to} />
              <AddressLine label="Cc" addresses={email.cc} />
              <AddressLine label="Bcc" addresses={email.bcc} />
              <AddressLine label="Reply-To" addresses={email.replyTo} />
              {email.messageId && (
                <div className="flex gap-2 text-sm">
                  <span className="w-14 shrink-0 text-muted-foreground">Message-ID</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{email.messageId}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
