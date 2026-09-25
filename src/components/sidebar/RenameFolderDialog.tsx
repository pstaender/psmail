import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type FolderInfo } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Asks for a new name and renames the folder on the account's IMAP server, in place (it stays
 * where it was in the hierarchy — only its own name changes). Cancel, not the name field, has
 * focus when the dialog opens: renaming is the less common, easier-to-regret action here.
 */
export function RenameFolderDialog({
  accountEmail,
  folder,
  open,
  onOpenChange,
  onRenamed,
}: {
  accountEmail: string;
  /** The folder being renamed; only its `name` is prefilled, the dialog otherwise doesn't need the rest. */
  folder: FolderInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Gets the server's folder list after the rename, and the folder's new path. */
  onRenamed: (folders: FolderInfo[], path: string) => void;
}) {
  const { token } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(folder?.name ?? "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || busy || !folder) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.renameFolder(token, accountEmail, folder.path, name);
      onRenamed(result.folders, result.path);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={e => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <form onSubmit={submit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>Renames "{folder?.path}" on the mail server of {accountEmail}, so every mail client sees the new name.</DialogDescription>
          </DialogHeader>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="space-y-1.5">
            <Label htmlFor="rename-folder-name">Name</Label>
            <Input id="rename-folder-name" value={name} onChange={e => setName(e.target.value)} />
          </div>

          <DialogFooter>
            <Button ref={cancelRef} type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === ""}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
