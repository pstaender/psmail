import { useState } from "react";
import {
  Archive,
  ChevronRight,
  File,
  Folder,
  Inbox,
  Loader2,
  Lock,
  MoreVertical,
  RefreshCw,
  Send,
  Settings,
  Trash2,
  Mail as MailIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useFolders } from "@/hooks/useFolders";
import { useSync } from "@/hooks/useSync";
import type { Account } from "../../server/types";
import type { FolderInfo } from "@/lib/api";

function folderIcon(folder: FolderInfo) {
  switch (folder.specialUse) {
    case "\\Inbox":
      return Inbox;
    case "\\Sent":
      return Send;
    case "\\Drafts":
      return File;
    case "\\Trash":
      return Trash2;
    case "\\Archive":
      return Archive;
    default:
      return Folder;
  }
}

export interface SharedFolders {
  accountEmail: string | null;
  folders: FolderInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function AccountRow({
  account,
  selected,
  onSelectFolder,
  onDeleteAccount,
  onEditAccount,
  sharedFolders,
  onSyncComplete,
}: {
  account: Account;
  selected: { accountEmail: string; folder: string } | null;
  onSelectFolder: (accountEmail: string, folder: string) => void;
  onDeleteAccount: (accountEmail: string) => void;
  onEditAccount: (accountEmail: string) => void;
  sharedFolders: SharedFolders;
  /** Called when a sync of this account finishes (successfully or not), so the rest of the app can pick up the new mail. */
  onSyncComplete?: (accountEmail: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const usingShared = sharedFolders.accountEmail === account.email;
  // When AppShell already has this account's folders loaded (it fetches them anyway, for the
  // move-to-folder menus, and keeps unread counts patched on read/flag/delete/move), reuse that
  // instead of fetching an independent copy that would only ever catch up on a full refresh.
  const own = useFolders(usingShared ? null : expanded ? account.email : null);
  const { folders, loading, error, refresh } = usingShared ? sharedFolders : own;
  const { isRunning, start, job } = useSync(account.email, () => {
    refresh();
    onSyncComplete?.(account.email);
  });

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="group flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent">
        <CollapsibleTrigger asChild>
          <button className="flex flex-1 items-center gap-1.5 text-left min-w-0">
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform text-muted-foreground", expanded && "rotate-90")} />
            <MailIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{account.displayName || account.email}</span>
            {account.readOnly && (
              <span title="Read-only" className="shrink-0">
                <Lock className="size-3 text-muted-foreground" />
              </span>
            )}
          </button>
        </CollapsibleTrigger>

        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
          disabled={isRunning}
          title="Sync now"
          onClick={() => start()}
        >
          {isRunning ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
              title="More actions"
            >
              <MoreVertical className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={() => onDeleteAccount(account.email)}>
              <Trash2 className="size-3.5" /> Remove account
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEditAccount(account.email)}>
              <Settings className="size-3.5" /> Account settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isRunning && job && (
        <p className="pl-8 text-xs text-muted-foreground">
          Syncing{(job.progressTotal > 0 ? ` ${job.progressCurrent}/${job.progressTotal}` : (job.progressCurrent > 0 ? ` #${job.progressCurrent}` : ''))}…
        </p>
      )}

      <CollapsibleContent className="pl-4">
        {/* Only the first load blanks the tree; a refresh (e.g. after a sync) keeps the folders on screen. */}
        {loading && folders.length === 0 && (
          <div className="flex items-center gap-2 py-1 pl-4 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading folders…
          </div>
        )}
        {error && folders.length === 0 && <p className="py-1 pl-4 text-xs text-destructive">{error}</p>}

        {folders.map(folder => {
            const Icon = folderIcon(folder);
            const isSelected = selected?.accountEmail === account.email && selected.folder === folder.path;
            return (
              <button
                key={folder.path}
                onClick={() => onSelectFolder(account.email, folder.path)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm truncate hover:bg-accent",
                  isSelected && "bg-accent font-medium"
                )}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{folder.name === 'INBOX' ? 'Inbox' : folder.name}</span>
                {folder.unread > 0 && (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {folder.unread}
                  </Badge>
                )}
              </button>
            );
          })}
      </CollapsibleContent>
    </Collapsible>
  );
}
