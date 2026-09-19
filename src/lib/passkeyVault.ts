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

interface StoredVault {
  v: 1;
  /** The WebAuthn credential id (base64url) that must be used to open it. */
  credentialId: string;
  /** The PRF input (base64url): the same salt always yields the same secret from the same credential. */
  salt: string;
  iv: string;
  ciphertext: string;
}

export type PasskeyErrorKind = "unsupported" | "no-prf" | "cancelled" | "failed";

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

function readVault(username: string): StoredVault | null {
  try {
    const raw = localStorage.getItem(storageKey(username));
    const parsed = raw ? (JSON.parse(raw) as StoredVault) : null;
    return parsed?.v === 1 ? parsed : null;
  } catch {
    return null;
  }
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
  return readVault(username) !== null;
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

/** Asks the authenticator (user verification required) for the PRF secret of `credentialId` and `salt`. */
async function evaluatePrf(credentialId: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "required",
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const results = (assertion?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)?.prf?.results;
  if (!results?.first) throw new PasskeyError("no-prf", "This passkey can't derive a key (no PRF support), so it can't protect the password.");
  return results.first;
}

/**
 * Creates a passkey for this profile on this device and stores `password` encrypted with a key only that passkey
 * can produce. Two prompts (creating, then using it once to derive the key). Throws PasskeyError; on any failure
 * nothing is stored.
 */
export async function savePassword(username: string, password: string): Promise<void> {
  if (!passkeysAvailable()) throw new PasskeyError("unsupported", "Passkeys aren't available in this browser.");

  try {
    const created = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "P.S.Mail" },
        user: { id: random(16), name: username, displayName: username },
        challenge: random(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        attestation: "none",
        timeout: 60_000,
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!created) throw new PasskeyError("failed", "No passkey was created.");

    const enabled = (created.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf?.enabled;
    if (!enabled) throw new PasskeyError("no-prf", "This browser or authenticator doesn't support the PRF extension, which is needed to protect the password.");

    const credentialId = new Uint8Array(created.rawId);
    const salt = random(32);
    const key = await deriveKey(await evaluatePrf(credentialId, salt));

    const iv = random(12);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(username) }, // bound to the profile: a blob can't be moved to another one
      key,
      new TextEncoder().encode(password)
    );
    const vault: StoredVault = { v: 1, credentialId: toBase64Url(credentialId), salt: toBase64Url(salt), iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
    localStorage.setItem(storageKey(username), JSON.stringify(vault));
  } catch (error) {
    throw asPasskeyError(error, "setting up passkey unlock");
  }
}

/** Prompts for the passkey (fingerprint / face / PIN / touch) and returns the stored password. */
export async function unlockPassword(username: string): Promise<string> {
  const vault = readVault(username);
  if (!vault) throw new PasskeyError("failed", "No passkey unlock is set up for this profile on this device.");

  try {
    const key = await deriveKey(await evaluatePrf(fromBase64Url(vault.credentialId), fromBase64Url(vault.salt)));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(vault.iv), additionalData: new TextEncoder().encode(username) },
      key,
      fromBase64Url(vault.ciphertext)
    );
    return new TextDecoder().decode(plain);
  } catch (error) {
    // AES-GCM refusing means the wrong secret (another passkey) or a modified blob.
    if (error instanceof Error && error.name === "OperationError") throw new PasskeyError("failed", "The saved password couldn't be unlocked with this passkey.");
    throw asPasskeyError(error, "unlocking the saved password");
  }
}
