/**
 * A stand-in for a WebAuthn authenticator with the PRF extension: credentials get a random secret that never leaves
 * this object, and `get` with a PRF salt returns HMAC-SHA256(secret, salt) — deterministic per credential + salt, like
 * a real hmac-secret. Lets tests exercise the passkey vault (and the login screen) without hardware.
 */
export interface FakeAuthenticator {
  /** How often each of create / get was asked for (i.e. how many prompts the user would have seen). */
  prompts: { create: number; get: number };
  /** Make the next prompt fail as if the user cancelled it. */
  cancelNext: () => void;
  /** Forget every credential (as if the passkey were deleted from the device). */
  wipe: () => void;
  uninstall: () => void;
}

export function installFakeAuthenticator(options: { prf?: boolean } = {}): FakeAuthenticator {
  const secrets = new Map<string, Uint8Array>();
  const prompts = { create: 0, get: 0 };
  let cancel = false;

  const key = (id: BufferSource) =>
    Buffer.from(ArrayBuffer.isView(id) ? new Uint8Array(id.buffer, id.byteOffset, id.byteLength) : new Uint8Array(id)).toString("hex");
  const maybeCancel = () => {
    if (cancel) {
      cancel = false;
      throw Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
    }
  };

  const credentials = {
    async create() {
      prompts.create += 1;
      maybeCancel();
      const id = crypto.getRandomValues(new Uint8Array(16));
      secrets.set(key(id), crypto.getRandomValues(new Uint8Array(32)));
      return { rawId: id.buffer, getClientExtensionResults: () => ({ prf: { enabled: options.prf !== false } }) };
    },
    async get(request: { publicKey: { allowCredentials: { id: BufferSource }[]; extensions?: { prf?: { eval?: { first: BufferSource } } } } }) {
      prompts.get += 1;
      maybeCancel();
      const secret = secrets.get(key(request.publicKey.allowCredentials[0]!.id));
      if (!secret) throw Object.assign(new Error("No matching credential."), { name: "NotAllowedError" });
      const salt = request.publicKey.extensions?.prf?.eval?.first;
      if (options.prf === false || !salt) return { getClientExtensionResults: () => ({}) };
      const hmacKey = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const output = await crypto.subtle.sign("HMAC", hmacKey, salt);
      return { getClientExtensionResults: () => ({ prf: { results: { first: output } } }) };
    },
  };

  const previousCredentials = Object.getOwnPropertyDescriptor(navigator, "credentials");
  const previousPublicKeyCredential = (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  Object.defineProperty(navigator, "credentials", { value: credentials, configurable: true });
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};

  return {
    prompts,
    cancelNext: () => {
      cancel = true;
    },
    wipe: () => secrets.clear(),
    uninstall: () => {
      if (previousCredentials) Object.defineProperty(navigator, "credentials", previousCredentials);
      else delete (navigator as { credentials?: unknown }).credentials;
      (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = previousPublicKeyCredential;
    },
  };
}
