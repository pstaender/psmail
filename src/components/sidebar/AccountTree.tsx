import { Inbox, Loader2, MailCheck, PanelLeftClose, RefreshCw, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UnifiedKind } from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AccountRow, type SharedFolders } from "./AccountRow";
import { AddAccountDialog } from "./AddAccountDialog";
import type { Account, DownloadJob } from "../../server/types";

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
  showImbox = false,
  imboxUnread = 0,
  unifiedInboxUnread,
  onSyncAllInboxes,
  syncingAccounts,
  syncJobs,
  onSync,
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
  /** Show the Imbox entry (the user turned it on in Settings). */
  showImbox?: boolean;
  /** Unread messages in the imbox: the badge on its entry. */
  imboxUnread?: number;
  /** Unread messages across all Inboxes, shown as a badge on the combined Inbox. */
  unifiedInboxUnread: number;
  /** Syncs the Inbox of every account (the combined Inbox's refresh button). */
  onSyncAllInboxes: () => void;
  /** How many accounts have a sync running right now (drives the button's spinner). */
  syncingAccounts: number;
  syncJobs: Record<string, DownloadJob>;
  onSync: (accountEmail: string) => void;
}) {
  return (
    <div className="flex h-full flex-col border-r bg-muted/20 overflow-y-auto">
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
            // The imbox (opt-in in Settings) sits between the combined Inbox and Sent.
            ...(showImbox ? ([{ kind: "imbox", label: "Imbox", Icon: MailCheck }] as const) : []),
            { kind: "sent", label: "Sent", Icon: Send },
          ] as const
        ).map(({ kind, label, Icon }) => (
          // The row is the click target (the inner button only carries the keyboard focus, its click bubbles up), so
          // the label, the sync button and the unread badge can sit side by side in this order.
          <div
            key={kind}
            title={`${label} of all accounts`}
            onClick={() => onSelectUnified(kind)}
            className={cn("group flex cursor-pointer items-center gap-1 rounded-md pr-2 hover:bg-accent", unifiedView === kind && "bg-accent font-medium")}
          >
            <button className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{label}</span>
            </button>
            {kind === "inbox" && (
              // While any account syncs, the spinner stays visible (with the count as its tooltip); the wrapper carries the
              // title because a disabled button gets no hover events.
              <span
                title={syncingAccounts > 0 ? `Syncing ${syncingAccounts} account${syncingAccounts === 1 ? "" : "s"}…` : undefined}
                className={cn("shrink-0", syncingAccounts > 0 && "cursor-progress")}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("size-6", syncingAccounts > 0 ? "pointer-events-none opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                  disabled={syncingAccounts > 0}
                  title={syncingAccounts > 0 ? undefined : "Sync the Inboxes of all accounts"}
                  onClick={e => {
                    e.stopPropagation();
                    onSyncAllInboxes();
                  }}
                >
                  {syncingAccounts > 0 ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                </Button>
              </span>
            )}
            {kind === "inbox" && unifiedInboxUnread > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {unifiedInboxUnread}
              </Badge>
            )}
            {kind === "imbox" && imboxUnread > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {imboxUnread}
              </Badge>
            )}
          </div>
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
              syncJob={syncJobs[account.email]}
              onSync={onSync}
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
