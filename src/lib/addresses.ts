import type { EmailAddress } from "../server/types";

const NAME_ADDR_RE = /^(.*)<(.+)>$/;

/** Parses a comma/semicolon separated recipient field like `Alice <a@x.com>, b@y.com`. */
export function parseAddressList(input: string): EmailAddress[] {
  return input
    .split(/[,;]/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const match = part.match(NAME_ADDR_RE);
      if (match) {
        const name = match[1]!.trim().replace(/^"|"$/g, "");
        const address = match[2]!.trim();
        return name ? { name, address } : { address };
      }
      return { address: part };
    });
}

export function formatAddressList(addresses: EmailAddress[]): string {
  return addresses.map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
}
