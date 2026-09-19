import { toast } from "sonner";
import { formatFullDate } from "@/lib/time";
import { newMailsTitle, senderLabel, sendersSummary, type NewMailHandlers, type NewMailResult } from "@/lib/notifications";
import type { EmailAddress } from "../../server/types";

function recipients(label: string, addresses: EmailAddress[]): string | null {
  if (addresses.length === 0) return null;
  const first = addresses[0]!.name || addresses[0]!.address;
  return `${label}: ${addresses.length > 1 ? `${first} +${addresses.length - 1}` : first}`;
}

const TOAST_MS = 12_000;

/**
 * The in-app toast for new mail. For one message: sender as the title, then the subject, the start
 * of the text, and a details line (date, To, Cc) with an "Open" button. For several: a count and who
 * they're from, with a button that shows the combined Inbox.
 */
export function showNewMailToast(result: NewMailResult, handlers: NewMailHandlers): void {
  if (result.total === 0) return;

  const single = result.total === 1 ? result.messages[0] : undefined;
  if (!single) {
    toast(newMailsTitle(result.total), {
      description: `From ${sendersSummary(result)}`,
      duration: TOAST_MS,
      action: { label: "Show inbox", onClick: handlers.openInbox },
    });
    return;
  }

  const details = [formatFullDate(single.date), recipients("To", single.to), recipients("Cc", single.cc)].filter(Boolean).join(" · ");
  toast(senderLabel(single.from), {
    description: (
      <div className="space-y-1">
        <div className="font-medium text-foreground">{single.subject || "(no subject)"}</div>
        {single.snippet && <div className="line-clamp-3 text-xs">{single.snippet}</div>}
        <div className="text-[11px] opacity-80">{details}</div>
      </div>
    ),
    duration: TOAST_MS,
    action: { label: "Open", onClick: () => handlers.openMail(single) },
  });
}
