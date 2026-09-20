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
  /** New credentials are created on device n (default 0) — i.e. "this is the authenticator the user touches now". A device refuses to register a credential it already holds. */
  useDevice: (device: number) => void;
  /** Make device n unavailable / available again (a security key unplugged, a laptop out of reach). Devices start out present. */
  unplug: (device: number) => void;
  plug: (device: number) => void;
  /** How many credentials it currently knows. */
  credentialCount: () => number;
  uninstall: () => void;
}

export function installFakeAuthenticator(options: { prf?: boolean } = {}): FakeAuthenticator {
  const secrets = new Map<string, { secret: Uint8Array; device: number }>(); // insertion order = creation order
  const unplugged = new Set<number>();
  let activeDevice = 0;
  const idBytes = (id: string) => Uint8Array.from(Buffer.from(id, "hex"));
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
    async create(request: { publicKey: { excludeCredentials?: { id: BufferSource }[] } }) {
      prompts.create += 1;
      maybeCancel();
      // Like a real authenticator: refuse to register a second credential for an id it was told to exclude — i.e. itself.
      if ((request.publicKey.excludeCredentials ?? []).some(excluded => secrets.get(key(excluded.id))?.device === activeDevice)) {
        throw Object.assign(new Error("The authenticator was previously registered."), { name: "InvalidStateError" });
      }
      const id = crypto.getRandomValues(new Uint8Array(16));
      secrets.set(key(id), { secret: crypto.getRandomValues(new Uint8Array(32)), device: activeDevice });
      return { rawId: id.buffer, getClientExtensionResults: () => ({ prf: { enabled: options.prf !== false } }) };
    },
    async get(request: {
      publicKey: {
        allowCredentials: { id: BufferSource }[];
        extensions?: { prf?: { eval?: { first: BufferSource }; evalByCredential?: Record<string, { first: BufferSource }> } };
      };
    }) {
      prompts.get += 1;
      maybeCancel();
      // The user touches whichever of the allowed authenticators is at hand: here, the first present one that holds a listed credential.
      const at = (candidate: { id: BufferSource }) => {
        const held = secrets.get(key(candidate.id));
        return held !== undefined && !unplugged.has(held.device);
      };
      const chosen = request.publicKey.allowCredentials.find(at);
      if (!chosen) throw Object.assign(new Error("No matching credential."), { name: "NotAllowedError" });
      const chosenKey = key(chosen.id);
      const secret = secrets.get(chosenKey)!.secret;

      const prf = request.publicKey.extensions?.prf;
      const base64Url = Buffer.from(chosenKey, "hex").toString("base64url");
      const salt = prf?.evalByCredential ? prf.evalByCredential[base64Url]?.first : prf?.eval?.first;
      const rawId = idBytes(chosenKey).buffer;
      if (options.prf === false || !salt) return { rawId, getClientExtensionResults: () => ({}) };
      const hmacKey = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const output = await crypto.subtle.sign("HMAC", hmacKey, salt);
      return { rawId, getClientExtensionResults: () => ({ prf: { results: { first: output } } }) };
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
    useDevice: device => {
      activeDevice = device;
    },
    unplug: device => {
      unplugged.add(device);
    },
    plug: device => {
      unplugged.delete(device);
    },
    credentialCount: () => secrets.size,
    uninstall: () => {
      if (previousCredentials) Object.defineProperty(navigator, "credentials", previousCredentials);
      else delete (navigator as { credentials?: unknown }).credentials;
      (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = previousPublicKeyCredential;
    },
  };
}
