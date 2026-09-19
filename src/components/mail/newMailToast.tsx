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

/** A toast that is one big click target: clicking (or Enter/Space) runs `onOpen` and dismisses it. */
function ClickableToast({ id, onOpen, children }: { id: string | number; onOpen: () => void; children: React.ReactNode }) {
  const open = () => {
    toast.dismiss(id);
    onOpen();
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="w-[356px] max-w-full cursor-pointer space-y-1 rounded-lg border bg-popover p-4 text-left text-foreground shadow-lg transition-colors hover:bg-accent"
    >
      {children}
    </div>
  );
}

/**
 * The in-app toast for new mail. For one message: sender, subject, the start of the text (monospace,
 * like the message views) and a details line (date, To, Cc). For several: a count and who they're
 * from. Clicking the toast opens that message, or the combined Inbox for several.
 */
export function showNewMailToast(result: NewMailResult, handlers: NewMailHandlers): void {
  if (result.total === 0) return;

  const single = result.total === 1 ? result.messages[0] : undefined;
  if (!single) {
    toast.custom(
      id => (
        <ClickableToast id={id} onOpen={handlers.openInbox}>
          <div className="text-sm font-semibold">{newMailsTitle(result.total)}</div>
          <div className="text-sm">From {sendersSummary(result)}</div>
        </ClickableToast>
      ),
      { duration: TOAST_MS }
    );
    return;
  }

  const details = [formatFullDate(single.date), recipients("To", single.to), recipients("Cc", single.cc)].filter(Boolean).join(" · ");
  toast.custom(
    id => (
      <ClickableToast id={id} onOpen={() => handlers.openMail(single)}>
        <div className="text-sm font-semibold">{senderLabel(single.from)}</div>
        <div className="text-sm font-medium">{single.subject || "(no subject)"}</div>
        {single.snippet && <div className="line-clamp-3 break-words font-mono text-xs">{single.snippet}</div>}
        <div className="text-[11px]">{details}</div>
      </ClickableToast>
    ),
    { duration: TOAST_MS }
  );
}
