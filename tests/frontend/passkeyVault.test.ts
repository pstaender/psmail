import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hasVault, passkeysAvailable, PasskeyError, removeVault, savePassword, unlockPassword } from "../../src/lib/passkeyVault";
import { installFakeAuthenticator, type FakeAuthenticator } from "../helpers/fakeAuthenticator";

let authenticator: FakeAuthenticator | null = null;
const stored = (username: string) => localStorage.getItem(`psmail.passkeyVault.${username}`);
const fail = async (promise: Promise<unknown>): Promise<PasskeyError> => {
  try {
    await promise;
  } catch (error) {
    return error as PasskeyError;
  }
  throw new Error("expected a PasskeyError");
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  authenticator?.uninstall();
  authenticator = null;
});

describe("passkey vault", () => {
  test("not available without WebAuthn: nothing is offered and nothing can be stored", async () => {
    expect(passkeysAvailable()).toBe(false);
    expect((await fail(savePassword("alice", "pw"))).kind).toBe("unsupported");
    expect(stored("alice")).toBeNull();
  });

  test("saves the password encrypted and unlocks it again with the same passkey", async () => {
    authenticator = installFakeAuthenticator();
    expect(passkeysAvailable()).toBe(true);
    expect(hasVault("alice")).toBe(false);

    await savePassword("alice", "correct horse battery staple");
    expect(hasVault("alice")).toBe(true);
    expect(authenticator.prompts).toEqual({ create: 1, get: 1 }); // creating the passkey, then using it once to derive the key

    // Only ciphertext is in localStorage — no trace of the password.
    const raw = stored("alice")!;
    expect(raw).not.toContain("correct horse");
    expect(raw).not.toContain(btoa("correct horse battery staple"));
    expect(JSON.parse(raw)).toMatchObject({ v: 1, credentialId: expect.any(String), salt: expect.any(String), iv: expect.any(String), ciphertext: expect.any(String) });

    expect(await unlockPassword("alice")).toBe("correct horse battery staple");
    expect(authenticator.prompts.get).toBe(2); // one more prompt per unlock
  });

  test("every save uses a fresh salt and IV, so two blobs of the same password differ", async () => {
    authenticator = installFakeAuthenticator();
    await savePassword("alice", "same");
    const first = JSON.parse(stored("alice")!);
    await savePassword("alice", "same");
    const second = JSON.parse(stored("alice")!);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(second.salt).not.toBe(first.salt);
    expect(second.iv).not.toBe(first.iv);
  });

  test("cancelling a prompt fails cleanly and stores nothing", async () => {
    authenticator = installFakeAuthenticator();
    authenticator.cancelNext();
    const error = await fail(savePassword("alice", "pw"));
    expect(error.kind).toBe("cancelled");
    expect(stored("alice")).toBeNull();

    await savePassword("alice", "pw");
    authenticator.cancelNext();
    expect((await fail(unlockPassword("alice"))).kind).toBe("cancelled");
    expect(hasVault("alice")).toBe(true); // a cancelled unlock doesn't destroy the vault
  });

  test("an authenticator without PRF is refused: no fallback that would only pretend to protect the password", async () => {
    authenticator = installFakeAuthenticator({ prf: false });
    const error = await fail(savePassword("alice", "pw"));
    expect(error.kind).toBe("no-prf");
    expect(stored("alice")).toBeNull();
  });

  test("a wiped passkey can't unlock, and a modified or moved blob is rejected", async () => {
    authenticator = installFakeAuthenticator();
    await savePassword("alice", "pw");

    // Tampering with the ciphertext.
    const vault = JSON.parse(stored("alice")!);
    const tampered = { ...vault, ciphertext: vault.ciphertext.slice(0, -4) + "AAAA" };
    localStorage.setItem("psmail.passkeyVault.alice", JSON.stringify(tampered));
    expect((await fail(unlockPassword("alice"))).kind).toBe("failed");

    // The blob copied to another profile doesn't open there (the profile name is part of what is authenticated).
    localStorage.setItem("psmail.passkeyVault.mallory", JSON.stringify(vault));
    expect((await fail(unlockPassword("mallory"))).kind).toBe("failed");

    // The passkey deleted from the device.
    localStorage.setItem("psmail.passkeyVault.alice", JSON.stringify(vault));
    authenticator.wipe();
    expect((await fail(unlockPassword("alice"))).kind).toBe("cancelled"); // the browser just says "not allowed"
  });

  test("vaults are per profile, can be removed, and unlocking without one is an error", async () => {
    authenticator = installFakeAuthenticator();
    await savePassword("alice", "pw-a");
    await savePassword("bob", "pw-b");
    expect(await unlockPassword("alice")).toBe("pw-a");
    expect(await unlockPassword("bob")).toBe("pw-b");

    removeVault("alice");
    expect(hasVault("alice")).toBe(false);
    expect(hasVault("bob")).toBe(true);
    expect((await fail(unlockPassword("alice"))).kind).toBe("failed");
  });
});
