import { useEffect, useState } from "react";
import { ChevronsUpDown, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

interface Category {
  label: string;
  count: number;
}

/**
 * Filter by category: pick the categories (the labels the AI gave the messages) in a searchable list, see the ones chosen as
 * labels that can be removed again, and Apply. A message needs every chosen category to be shown.
 */
export function CategoryFilterDialog({
  open,
  onOpenChange,
  value,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The categories in effect. */
  value: string[];
  onApply: (categories: string[]) => void;
}) {
  const { token } = useAuth();
  const [selected, setSelected] = useState<string[]>(value);
  const [available, setAvailable] = useState<Category[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    if (!open || !token) return;
    setSelected(value);
    setListOpen(false);
    setError(null);
    setAvailable(null);
    let cancelled = false;
    api
      .listCategories(token)
      .then(list => !cancelled && setAvailable(list))
      .catch(err => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [open, token, value]);

  const choices = (available ?? []).filter(category => !selected.includes(category.label));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          noValidate
          className="space-y-4"
          onSubmit={e => {
            e.preventDefault();
            onApply(selected);
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Filter by category</DialogTitle>
            <DialogDescription>Show only the messages that have all of the chosen categories.</DialogDescription>
          </DialogHeader>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Popover open={listOpen} onOpenChange={setListOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" role="combobox" aria-expanded={listOpen} aria-label="Add a category" className="w-full justify-between">
                <span className="text-muted-foreground">
                  {available === null && !error ? "Loading categories…" : "Add a category…"}
                </span>
                {available === null && !error ? <Loader2 className="size-4 animate-spin" /> : <ChevronsUpDown className="size-4 opacity-50" />}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-64 p-0">
              <Command>
                <CommandInput placeholder="Find a category…" />
                <CommandList>
                  <CommandEmpty>{available?.length === 0 ? "No message has categories yet." : "No category found."}</CommandEmpty>
                  <CommandGroup>
                    {choices.map(category => (
                      <CommandItem
                        key={category.label}
                        value={category.label}
                        onSelect={() => {
                          setSelected(prev => [...prev, category.label]);
                          setListOpen(false);
                        }}
                      >
                        <span className="flex-1 truncate">{category.label}</span>
                        <span className="text-xs text-muted-foreground">{category.count}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {selected.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Chosen categories">
              {selected.map(label => (
                <li key={label}>
                  <Badge variant="secondary" className="gap-1 pr-1">
                    {label}
                    <button
                      type="button"
                      className="rounded-sm p-0.5 hover:bg-background/60"
                      title={`Remove ${label}`}
                      aria-label={`Remove ${label}`}
                      onClick={() => setSelected(prev => prev.filter(l => l !== label))}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No category chosen: every message is shown.</p>
          )}

          <DialogFooter>
            {value.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                onClick={() => {
                  onApply([]);
                  onOpenChange(false);
                }}
              >
                Clear filter
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
