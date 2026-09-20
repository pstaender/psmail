import { useEffect, useState } from "react";
import {
  Archive,
  Ban,
  ChevronRight,
  File,
  Folder,
  FolderPlus,
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
import type { Account, DownloadJob } from "../../server/types";
import type { FolderInfo } from "@/lib/api";
import { NewFolderDialog } from "./NewFolderDialog";
import { toast } from "sonner";

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
  /** The mail server couldn't be reached: the list is only what is stored locally (the reason). */
  warning: string | null;
  refresh: () => void;
}

export function AccountRow({
  account,
  selected,
  onSelectFolder,
  onDeleteAccount,
  onEditAccount,
  sharedFolders,
  syncJob,
  onSync,
}: {
  account: Account;
  selected: { accountEmail: string; folder: string } | null;
  onSelectFolder: (accountEmail: string, folder: string) => void;
  onDeleteAccount: (accountEmail: string) => void;
  onEditAccount: (accountEmail: string) => void;
  sharedFolders: SharedFolders;
  /** This account's latest sync job, if any (see useSyncJobs). */
  syncJob: DownloadJob | undefined;
  onSync: (accountEmail: string) => void;
}) {
  // Collapsed until something in the account is selected (no account is, when the app has just loaded and
  // shows the combined Inbox) — which also means a collapsed account's folders aren't even fetched.
  const [expanded, setExpanded] = useState(false);
  const isSelectedAccount = selected?.accountEmail === account.email;
  useEffect(() => {
    if (isSelectedAccount) setExpanded(true);
  }, [isSelectedAccount]);
  const usingShared = sharedFolders.accountEmail === account.email;
  // When AppShell already has this account's folders loaded (it fetches them anyway, for the
  // move-to-folder menus, and keeps unread counts patched on read/flag/delete/move), reuse that
  // instead of fetching an independent copy that would only ever catch up on a full refresh.
  const own = useFolders(usingShared ? null : expanded ? account.email : null);
  const { folders, loading, error, warning, refresh } = usingShared ? sharedFolders : own;
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const job = syncJob;
  const isRunning = job?.status === "pending" || job?.status === "running";
  const syncLabel = job
    ? `Syncing${job.progressTotal > 0 ? ` ${job.progressCurrent}/${job.progressTotal}` : job.progressCurrent > 0 ? ` #${job.progressCurrent}` : ""}…`
    : "Syncing…";

  // When a sync ends, re-read this account's folder counts (in place — see useFolders). Keyed on the
  // job reaching a finished state rather than on "was running" so a sync too quick to ever render as
  // running still refreshes.
  const finished = job?.status === "completed" || job?.status === "failed";
  useEffect(() => {
    if (finished) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, finished]);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="group flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent">
        <CollapsibleTrigger asChild>
          <button className="flex flex-1 items-center gap-1.5 text-left min-w-0">
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform text-muted-foreground", expanded && "rotate-90")} />
            <MailIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={cn("truncate text-sm font-medium", account.disabled && "text-muted-foreground line-through decoration-muted-foreground/40")}>
              {account.displayName || account.email}
            </span>
            {account.disabled && (
              <span title="Disabled" className="shrink-0">
                <Ban className="size-3 text-muted-foreground" />
              </span>
            )}
            {account.readOnly && !account.disabled && (
              <span title="Read-only" className="shrink-0">
                <Lock className="size-3 text-muted-foreground" />
              </span>
            )}
          </button>
        </CollapsibleTrigger>

        {/* While syncing, the progress is a tooltip on the spinner (title on a wrapper: a disabled button gets no hover events). A disabled account can't be synced: no button. */}
        {!account.disabled && (
        <span title={isRunning ? syncLabel : undefined} className={cn("shrink-0", isRunning && "cursor-progress")}>
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-6", isRunning ? "pointer-events-none opacity-100" : "opacity-0 group-hover:opacity-100")}
            disabled={isRunning}
            title={isRunning ? undefined : "Sync now"}
            onClick={() => onSync(account.email)}
          >
            {isRunning ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </span>
        )}

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
            {!account.disabled && !account.readOnly && (
              <DropdownMenuItem
                onClick={() => {
                  setExpanded(true); // the folder list has to be loaded to offer the parents
                  setNewFolderOpen(true);
                }}
              >
                <FolderPlus className="size-3.5" /> New folder…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onEditAccount(account.email)}>
              <Settings className="size-3.5" /> Account settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <NewFolderDialog
        accountEmail={account.email}
        folders={folders}
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        onCreated={(_, path) => {
          refresh(); // the server has remembered the new list; reload it (and the counts) the usual way
          toast.success(`Folder "${path}" was created.`);
        }}
      />

      <CollapsibleContent className="pl-4">
        {/* Only the first load blanks the tree; a refresh (e.g. after a sync) keeps the folders on screen. */}
        {loading && folders.length === 0 && (
          <div className="flex items-center gap-2 py-1 pl-4 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading folders…
          </div>
        )}
        {error && folders.length === 0 && <p className="py-1 pl-4 text-xs text-destructive">{error}</p>}
        {warning && folders.length > 0 && (
          <p className="py-1 pl-4 text-xs text-muted-foreground" title={warning}>
            Server not reachable — showing the stored folders.
          </p>
        )}

        {folders.map(folder => {
            const Icon = folderIcon(folder);
            const isSelected = selected?.accountEmail === account.email && selected.folder === folder.path;
            const depth = folder.delimiter ? folder.path.split(folder.delimiter).length - 1 : 0;
            return (
              <button
                key={folder.path}
                onClick={() => onSelectFolder(account.email, folder.path)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm truncate hover:bg-accent",
                  isSelected && "bg-accent font-medium"
                )}
                style={depth > 0 ? { paddingLeft: `${0.5 + depth * 0.75}rem` } : undefined}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{folder.name.toLowerCase() === 'inbox' ? 'Inbox' : folder.name}</span>
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
