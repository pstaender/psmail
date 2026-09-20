/**
 * Remembering the login password on this device, protected by a passkey / Touch ID / security key.
 *
 * How it works (and why it is meaningful): a WebAuthn credential created with the PRF extension (the "hmac-secret"
 * of FIDO2) can compute a secret from a salt *inside the authenticator*, and only after the user verified
 * themselves (fingerprint, face, PIN, touch). That secret is turned into an AES-GCM key that encrypts the password;
 * only the ciphertext lives in localStorage. Without the authenticator and a successful user verification the
 * stored blob is useless — and, unlike "ask for a passkey and then decrypt with a key kept next to the data", the
 * key never exists in the page until the user has just proven presence.
 *
 * Where PRF isn't available (older browsers, some authenticators) nothing is stored: gating a decryption key that
 * sits in localStorage behind a passkey prompt would be theatre, so there is deliberately no such fallback.
 */

const STORAGE_PREFIX = "psmail.passkeyVault.";
const HKDF_INFO = new TextEncoder().encode("psmail passkey vault v1");

/**
 * One passkey's copy of the password: encrypted with a key only that credential can produce. A profile can have
 * several (Touch ID and a security key, say) — every entry holds the same password under a different key, so any
 * one of the passkeys opens it, and removing one leaves the others working.
 */
interface VaultEntry {
  /** The WebAuthn credential id (base64url) that must be used to open it. */
  credentialId: string;
  /** The PRF input (base64url): the same salt always yields the same secret from the same credential. */
  salt: string;
  iv: string;
  ciphertext: string;
  /** When this passkey was added (ISO), for the list in Settings; empty for vaults written before entries had dates. */
  addedAt: string;
}

/** What is stored: v2 holds any number of entries; v1 (a single passkey, no list) is still read. */
type StoredVault = { v: 2; entries: VaultEntry[] } | ({ v: 1 } & Omit<VaultEntry, "addedAt">);

export type PasskeyErrorKind = "unsupported" | "no-prf" | "cancelled" | "duplicate" | "failed";

export class PasskeyError extends Error {
  constructor(public kind: PasskeyErrorKind, message: string) {
    super(message);
  }
}

// ---- helpers ------------------------------------------------------------------------------------------------

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

function storageKey(username: string): string {
  return STORAGE_PREFIX + username;
}

function readEntries(username: string): VaultEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(username));
    const parsed = raw ? (JSON.parse(raw) as StoredVault) : null;
    if (parsed?.v === 2 && Array.isArray(parsed.entries)) return parsed.entries;
    if (parsed?.v === 1) return [{ credentialId: parsed.credentialId, salt: parsed.salt, iv: parsed.iv, ciphertext: parsed.ciphertext, addedAt: "" }];
  } catch {
    // unreadable — same as none
  }
  return [];
}

function writeEntries(username: string, entries: VaultEntry[]): void {
  if (entries.length === 0) localStorage.removeItem(storageKey(username));
  else localStorage.setItem(storageKey(username), JSON.stringify({ v: 2, entries } satisfies StoredVault));
}

/** Whether this browser can do passkeys at all (a necessary, not sufficient, condition: PRF support is only known once an authenticator is asked). */
export function passkeysAvailable(): boolean {
  try {
    return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials?.create && !!globalThis.crypto?.subtle;
  } catch {
    return false;
  }
}

export function hasVault(username: string): boolean {
  return readEntries(username).length > 0;
}

/** The passkeys set up for this profile on this device, oldest first (for the list in Settings). */
export function listPasskeys(username: string): { credentialId: string; addedAt: string }[] {
  return readEntries(username).map(({ credentialId, addedAt }) => ({ credentialId, addedAt }));
}

/** Removes one passkey's copy; when it was the last one the whole vault goes. The passkey itself stays on its device. */
export function removePasskey(username: string, credentialId: string): void {
  try {
    writeEntries(username, readEntries(username).filter(entry => entry.credentialId !== credentialId));
  } catch {
    // storage unavailable
  }
}

export function removeVault(username: string): void {
  try {
    localStorage.removeItem(storageKey(username));
  } catch {
    // storage unavailable — nothing to remove
  }
}

function asPasskeyError(error: unknown, doing: string): PasskeyError {
  if (error instanceof PasskeyError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return new PasskeyError("cancelled", `The passkey prompt was cancelled or timed out while ${doing}.`);
  if (name === "InvalidStateError") return new PasskeyError("duplicate", "This passkey is already set up for this profile — use another authenticator to add a second one.");
  if (name === "NotSupportedError" || name === "SecurityError") return new PasskeyError("unsupported", `This browser or device can't use a passkey here (${doing}).`);
  return new PasskeyError("failed", `Passkey problem while ${doing}: ${error instanceof Error ? error.message : String(error)}`);
}

async function deriveKey(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Asks for any of `entries`' passkeys (the browser lets the user pick whichever authenticator is at hand; user
 * verification required) and returns the entry that answered with its PRF secret. One entry uses the plain `eval`
 * input; several need `evalByCredential`, which maps each credential to its own salt.
 */
async function evaluatePrf(entries: VaultEntry[]): Promise<{ entry: VaultEntry; secret: ArrayBuffer }> {
  const prf =
    entries.length === 1
      ? { eval: { first: fromBase64Url(entries[0]!.salt) } }
      : { evalByCredential: Object.fromEntries(entries.map(entry => [entry.credentialId, { first: fromBase64Url(entry.salt) }])) };

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: entries.map(entry => ({ type: "public-key" as const, id: fromBase64Url(entry.credentialId) })),
      userVerification: "required",
      timeout: 60_000,
      extensions: { prf } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new PasskeyError("failed", "No passkey answered.");

  // Which of the passkeys was it? The answer carries the credential id.
  const answered = new Uint8Array(assertion.rawId);
  const entry = entries.length === 1 ? entries[0]! : entries.find(candidate => bytesEqual(fromBase64Url(candidate.credentialId), answered));
  const first = (assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
  if (!entry) throw new PasskeyError("failed", "An unknown passkey answered.");
  if (!first) throw new PasskeyError("no-prf", "This passkey can't derive a key (no PRF support), so it can't protect the password.");
  return { entry, secret: first };
}

/** Creates a passkey and returns an entry holding `password` under the key only it can produce. Prompts twice (create, then derive). */
async function createEntry(username: string, password: string, existing: VaultEntry[]): Promise<VaultEntry> {
  const created = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "P.S.Mail" },
      user: { id: random(16), name: username, displayName: username },
      challenge: random(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      // The passkeys already set up are excluded, so the same authenticator can't be added twice.
      excludeCredentials: existing.map(entry => ({ type: "public-key" as const, id: fromBase64Url(entry.credentialId) })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 60_000,
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!created) throw new PasskeyError("failed", "No passkey was created.");

  const enabled = (created.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf?.enabled;
  if (!enabled) throw new PasskeyError("no-prf", "This browser or authenticator doesn't support the PRF extension, which is needed to protect the password.");

  const credentialId = toBase64Url(created.rawId);
  const salt = random(32);
  const fresh: VaultEntry = { credentialId, salt: toBase64Url(salt), iv: "", ciphertext: "", addedAt: new Date().toISOString() };
  const { secret } = await evaluatePrf([fresh]); // uses the new passkey once, to get its key

  const iv = random(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(username) }, // bound to the profile: a blob can't be moved to another one
    await deriveKey(secret),
    new TextEncoder().encode(password)
  );
  return { ...fresh, iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
}

/**
 * Creates a passkey for this profile on this device and stores `password` encrypted with a key only that passkey
 * can produce, replacing any earlier passkeys of the profile (this is the first-time setup at sign-in; see
 * addPasskey for more). Two prompts (creating, then using it once to derive the key). Throws PasskeyError; on any
 * failure nothing is stored.
 */
export async function savePassword(username: string, password: string): Promise<void> {
  if (!passkeysAvailable()) throw new PasskeyError("unsupported", "Passkeys aren't available in this browser.");
  try {
    writeEntries(username, [await createEntry(username, password, [])]);
  } catch (error) {
    throw asPasskeyError(error, "setting up passkey unlock");
  }
}

/**
 * Adds another passkey (a second device's authenticator, a backup security key) to a profile that already has one:
 * unlocks the stored password with an existing passkey, then creates the new passkey and stores the same password
 * under its key. Prompts: one to unlock, two for the new passkey. Nothing changes if any step fails.
 */
export async function addPasskey(username: string): Promise<void> {
  if (!passkeysAvailable()) throw new PasskeyError("unsupported", "Passkeys aren't available in this browser.");
  try {
    const password = await unlockPassword(username);
    const entries = readEntries(username);
    writeEntries(username, [...entries, await createEntry(username, password, entries)]);
  } catch (error) {
    throw asPasskeyError(error, "adding a passkey");
  }
}

/** Prompts for a passkey (fingerprint / face / PIN / touch — any of the profile's) and returns the stored password. */
export async function unlockPassword(username: string): Promise<string> {
  const entries = readEntries(username);
  if (entries.length === 0) throw new PasskeyError("failed", "No passkey unlock is set up for this profile on this device.");

  try {
    const { entry, secret } = await evaluatePrf(entries);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(entry.iv), additionalData: new TextEncoder().encode(username) },
      await deriveKey(secret),
      fromBase64Url(entry.ciphertext)
    );
    return new TextDecoder().decode(plain);
  } catch (error) {
    // AES-GCM refusing means the wrong secret (another passkey) or a modified blob.
    if (error instanceof Error && error.name === "OperationError") throw new PasskeyError("failed", "The saved password couldn't be unlocked with this passkey.");
    throw asPasskeyError(error, "unlocking the saved password");
  }
}
