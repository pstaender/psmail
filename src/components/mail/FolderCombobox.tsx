import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { FolderInfo } from "@/lib/api";

/**
 * Picks a folder (for Move): a shadcn combobox — a button that opens a searchable list, so a folder is found by
 * typing part of its name or path instead of scrolling. Enter or a click chooses; Esc closes.
 */
export function FolderCombobox({
  folders,
  onPick,
  onOpenChange,
  children,
  disabled = false,
  title,
  align = "start",
}: {
  folders: FolderInfo[];
  onPick: (folder: string) => void;
  /** Told when the list opens or closes (the reading-pane toolbar stays up while it is open). */
  onOpenChange?: (open: boolean) => void;
  /** The button's content. */
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const change = (value: boolean) => {
    setOpen(value);
    onOpenChange?.(value);
  };

  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} title={title} role="combobox" aria-label="Move to folder" aria-expanded={open}>
          {children}
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Find a folder…" />
          <CommandList>
            <CommandEmpty>No folder found.</CommandEmpty>
            <CommandGroup>
              {folders.map(folder => (
                <CommandItem
                  key={folder.path}
                  value={folder.path}
                  keywords={[folder.name]}
                  onSelect={() => {
                    change(false);
                    onPick(folder.path);
                  }}
                >
                  <span className="truncate">{folder.path.toUpperCase() === "INBOX" ? "Inbox" : folder.path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
