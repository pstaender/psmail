import { Inbox, Loader2, PanelLeftClose, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UnifiedKind } from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AccountRow, type SharedFolders } from "./AccountRow";
import { AddAccountDialog } from "./AddAccountDialog";
import type { Account } from "../../server/types";

export function AccountTree({
  accounts,
  loading,
  refreshAccounts,
  selected,
  onSelectFolder,
  onDeleteAccount,
  onEditAccount,
  onCollapse,
  sharedFolders,
  unifiedView,
  onSelectUnified,
  unifiedInboxUnread,
  onSyncComplete,
}: {
  accounts: Account[];
  loading: boolean;
  refreshAccounts: () => void;
  selected: { accountEmail: string; folder: string } | null;
  onSelectFolder: (accountEmail: string, folder: string) => void;
  onDeleteAccount: (accountEmail: string) => void;
  onEditAccount: (accountEmail: string) => void;
  onCollapse: () => void;
  /**
   * The already-fetched folder list for whichever account is currently selected — AppShell
   * fetches this anyway (for the move-to-folder menus) and keeps its unread counts patched
   * optimistically on read/flag/delete/move, so the matching row here reuses it instead of
   * fetching (and staying stale) on its own. See AccountRow.
   */
  sharedFolders: SharedFolders;
  /** Which cross-account mailbox (all Inboxes / all Sents) is showing, if any. */
  unifiedView: UnifiedKind | null;
  onSelectUnified: (kind: UnifiedKind) => void;
  /** Unread messages across all Inboxes, shown as a badge on the combined Inbox. */
  unifiedInboxUnread: number;
  onSyncComplete: (accountEmail: string) => void;
}) {
  return (
    <div className="flex h-full flex-col border-r bg-muted/20">
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <span className="text-sm font-semibold">Accounts</span>
        <Button variant="ghost" size="icon" className="size-6" onClick={onCollapse} title="Collapse accounts">
          <PanelLeftClose className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-0.5 px-2 pb-2">
        {(
          [
            { kind: "inbox", label: "Inbox", Icon: Inbox },
            { kind: "sent", label: "Sent", Icon: Send },
          ] as const
        ).map(({ kind, label, Icon }) => (
          <button
            key={kind}
            onClick={() => onSelectUnified(kind)}
            title={`${label} of all accounts`}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
              unifiedView === kind && "bg-accent font-medium"
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{label}</span>
            {kind === "inbox" && unifiedInboxUnread > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {unifiedInboxUnread}
              </Badge>
            )}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1 px-2">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}
        <div className="space-y-1 pb-2">
          {accounts.map(account => (
            <AccountRow
              key={account.id}
              account={account}
              selected={selected}
              onSelectFolder={onSelectFolder}
              onDeleteAccount={onDeleteAccount}
              onEditAccount={onEditAccount}
              sharedFolders={sharedFolders}
              onSyncComplete={onSyncComplete}
            />
          ))}
        </div>
      </ScrollArea>

      <div className="border-t p-2">
        <AddAccountDialog onCreated={refreshAccounts} />
      </div>
    </div>
  );
}
