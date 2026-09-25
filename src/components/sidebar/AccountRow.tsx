import { useEffect, useMemo, useState } from "react";
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
import { useUiSettings } from "@/contexts/UiSettingsContext";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useFolders } from "@/hooks/useFolders";
import type { Account, DownloadJob } from "../../server/types";
import type { FolderInfo } from "@/lib/api";
import { NewFolderDialog } from "./NewFolderDialog";
import { toast } from "sonner";

interface FolderNode {
  folder: FolderInfo;
  /** Paths of the folders it sits inside, outermost first (only folders the list actually has). */
  ancestors: string[];
  depth: number;
  hasChildren: boolean;
  /** Unread messages in all the folders below it. */
  hiddenUnread: number;
}

/** The flat folder list as a tree: nesting follows the paths (`Work/2024` is inside `Work`); the order is the server's. */
function buildFolderTree(folders: FolderInfo[]): FolderNode[] {
  const nodes = folders.map(folder => {
    const ancestors = folders
      .filter(other => other !== folder && other.delimiter && folder.path.startsWith(other.path + other.delimiter))
      .sort((a, b) => a.path.length - b.path.length)
      .map(other => other.path);
    return { folder, ancestors, depth: ancestors.length, hasChildren: false, hiddenUnread: 0 };
  });
  for (const node of nodes) {
    for (const ancestor of node.ancestors) {
      const parent = nodes.find(n => n.folder.path === ancestor)!;
      parent.hasChildren = true;
      parent.hiddenUnread += node.folder.unread;
    }
  }
  return nodes;
}

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
  onSyncFolder,
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
  /** Syncs just this one folder (the sync button that shows on hovering a folder row). */
  onSyncFolder: (accountEmail: string, folder: string) => void;
}) {
  const { showUnreadBadges } = useUiSettings();
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
  // Folders whose subfolders are showing; every folder starts collapsed.
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const setFolderOpen = (path: string, open: boolean) =>
    setOpenFolders(prev => (prev.has(path) === open ? prev : new Set(open ? [...prev, path] : [...prev].filter(p => p !== path))));
  const toggleFolder = (path: string) => setFolderOpen(path, !openFolders.has(path));
  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const visibleFolders = tree.filter(node => node.ancestors.every(path => openFolders.has(path)));
  // The selected folder (a link, a new folder, a new-mail click…) is never hidden inside a collapsed parent.
  const selectedPath = isSelectedAccount ? selected!.folder : null;
  useEffect(() => {
    const ancestors = tree.find(node => node.folder.path === selectedPath)?.ancestors;
    if (ancestors?.some(path => !openFolders.has(path))) setOpenFolders(prev => new Set([...prev, ...ancestors]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, tree]);
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
        onCreated={(created, path) => {
          const ancestors = buildFolderTree(created).find(node => node.folder.path === path)?.ancestors ?? [];
          if (ancestors.length > 0) setOpenFolders(prev => new Set([...prev, ...ancestors])); // show it where it was put
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

        {visibleFolders.map(({ folder, depth, hasChildren, hiddenUnread }) => {
            const Icon = folderIcon(folder);
            const isSelected = selected?.accountEmail === account.email && selected.folder === folder.path;
            const isOpen = openFolders.has(folder.path);
            const unread = folder.unread + (hasChildren && !isOpen ? hiddenUnread : 0); // a collapsed folder still shows what's unread inside it
            const label = folder.name.toLowerCase() === "inbox" ? "Inbox" : folder.name;
            // An account-wide sync ("Sync now", job.folder null) covers this folder too, but only gets its own spinner
            // here when it's THIS folder specifically — the account-level spinner already says the rest is syncing.
            const folderSyncing = isRunning && job?.folder === folder.path;
            return (
              <div key={folder.path} className="group flex items-center" style={depth > 0 ? { paddingLeft: `${depth * 0.75}rem` } : undefined}>
                {/* Folders with subfolders start collapsed; the arrow (or a click on the folder) opens them. */}
                {hasChildren ? (
                  <button
                    type="button"
                    className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${folder.name}`}
                    aria-expanded={isOpen}
                    onClick={() => toggleFolder(folder.path)}
                  >
                    <ChevronRight className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
                  </button>
                ) : (
                  <span className="size-5 shrink-0" /> // keeps the names aligned
                )}
                <button
                  onClick={() => {
                    if (hasChildren) setFolderOpen(folder.path, true);
                    onSelectFolder(account.email, folder.path);
                  }}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm truncate hover:bg-accent",
                    isSelected && "bg-accent font-medium"
                  )}
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{label}</span>
                  {showUnreadBadges && unread > 0 && (
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {unread}
                    </Badge>
                  )}
                </button>
                {!account.disabled && (
                  <span title={folderSyncing ? syncLabel : undefined} className={cn("shrink-0", folderSyncing && "cursor-progress")}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("size-6", folderSyncing ? "pointer-events-none opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                      disabled={isRunning}
                      title={folderSyncing ? undefined : `Sync ${label}`}
                      onClick={e => {
                        e.stopPropagation();
                        onSyncFolder(account.email, folder.path);
                      }}
                    >
                      {folderSyncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    </Button>
                  </span>
                )}
              </div>
            );
          })}
      </CollapsibleContent>
    </Collapsible>
  );
}
