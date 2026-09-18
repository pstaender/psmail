import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { api, type Contact } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 120;

/** The recipient currently being typed: everything after the last `,` or `;`. */
function splitCurrentToken(value: string): { head: string; token: string } {
  const cut = Math.max(value.lastIndexOf(","), value.lastIndexOf(";")) + 1;
  return { head: value.slice(0, cut), token: value.slice(cut).trim() };
}

function formatContact(contact: Contact): string {
  // Commas/semicolons would be read as recipient separators by parseAddressList, so they can't stay in a name.
  const name = contact.name.replace(/[,;<>"]/g, "").trim();
  return name ? `${name} <${contact.address}>` : contact.address;
}

/**
 * A comma-separated recipient field (To/Cc/Bcc) with autocomplete from the account's contacts: as you
 * type the current recipient, suggestions come from GET /api/accounts/:email/contacts. Suggestion lookups
 * are debounced, cancelled when superseded, and remembered per query so typing/backspacing over the same
 * prefix doesn't hit the server again. A failing lookup just means no suggestions — it never blocks typing.
 */
export function RecipientInput({
  id,
  accountEmail,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  accountEmail: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { token } = useAuth();
  const listId = useId();
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const cache = useRef(new Map<string, Contact[]>());
  const seq = useRef(0);

  // A different account has different contacts.
  useEffect(() => {
    cache.current.clear();
  }, [accountEmail]);

  const { head, token: current } = splitCurrentToken(value);

  useEffect(() => {
    if (!token || current.length === 0) {
      setSuggestions([]);
      return;
    }
    const key = current.toLowerCase();
    const cached = cache.current.get(key);
    if (cached) {
      setSuggestions(cached);
      setActive(0);
      return;
    }

    const controller = new AbortController();
    const mySeq = ++seq.current;
    const timer = setTimeout(() => {
      api
        .suggestContacts(token, accountEmail, current, controller.signal)
        .then(result => {
          if (mySeq !== seq.current) return;
          cache.current.set(key, result);
          setSuggestions(result);
          setActive(0);
        })
        .catch(() => {
          if (mySeq === seq.current) setSuggestions([]);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [current, token, accountEmail]);

  const alreadyEntered = new Set(
    head
      .split(/[,;]/)
      .map(part => part.match(/<(.+)>/)?.[1] ?? part)
      .map(part => part.trim().toLowerCase())
      .filter(Boolean)
  );
  const visible = suggestions.filter(s => !alreadyEntered.has(s.address));
  const showList = open && current.length > 0 && visible.length > 0;

  function accept(contact: Contact) {
    const prefix = head && !/\s$/.test(head) ? `${head} ` : head;
    onChange(`${prefix}${formatContact(contact)}, `);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showList) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(i => (i + 1) % visible.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(i => (i - 1 + visible.length) % visible.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      accept(visible[Math.min(active, visible.length - 1)]!);
    } else if (e.key === "Escape") {
      // Only closes the list — not the surrounding dialog.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList ? `${listId}-${active}` : undefined}
        onChange={e => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
        >
          {visible.map((contact, i) => (
            <li
              key={contact.address}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // mousedown (not click) so the input keeps focus and its blur doesn't close the list first.
              onMouseDown={e => {
                e.preventDefault();
                accept(contact);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn("cursor-pointer px-3 py-1.5 text-sm", i === active && "bg-accent")}
            >
              {contact.name ? (
                <>
                  <span className="font-medium">{contact.name}</span>{" "}
                  <span className="text-muted-foreground">{contact.address}</span>
                </>
              ) : (
                contact.address
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
