import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addPasskey, hasVault, listPasskeys, passkeysAvailable, PasskeyError, removePasskey, removeVault, savePassword, unlockPassword } from "../../src/lib/passkeyVault";
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
    expect(JSON.parse(raw)).toMatchObject({ v: 2, entries: [{ credentialId: expect.any(String), salt: expect.any(String), iv: expect.any(String), ciphertext: expect.any(String) }] });

    expect(await unlockPassword("alice")).toBe("correct horse battery staple");
    expect(authenticator.prompts.get).toBe(2); // one more prompt per unlock
  });

  test("every save uses a fresh salt and IV, so two blobs of the same password differ", async () => {
    authenticator = installFakeAuthenticator();
    await savePassword("alice", "same");
    const first = JSON.parse(stored("alice")!).entries[0];
    await savePassword("alice", "same");
    const second = JSON.parse(stored("alice")!).entries[0];
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
    const entry = vault.entries[0];
    const tampered = { ...vault, entries: [{ ...entry, ciphertext: entry.ciphertext.slice(0, -4) + "AAAA" }] };
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

  describe("several passkeys per profile", () => {
    test("adding another passkey unlocks with an existing one first, and then either passkey opens the password", async () => {
      authenticator = installFakeAuthenticator();
      await savePassword("alice", "shared-secret");
      expect(listPasskeys("alice")).toHaveLength(1);
      const before = { ...authenticator.prompts };

      authenticator.useDevice(1); // the second authenticator (a security key) is the one that registers now
      await addPasskey("alice");
      expect(authenticator.prompts).toEqual({ create: before.create + 1, get: before.get + 2 }); // unlock, then create + derive
      expect(listPasskeys("alice")).toHaveLength(2);
      expect(authenticator.credentialCount()).toBe(2);
      expect(JSON.parse(stored("alice")!).entries.map((e: { ciphertext: string }) => e.ciphertext)).toHaveLength(2);
      expect(stored("alice")).not.toContain("shared-secret");

      // Both authenticators at hand: it opens.
      expect(await unlockPassword("alice")).toBe("shared-secret");
      // Only the second one is at hand (the first, say a laptop, is elsewhere): still opens.
      authenticator.unplug(0);
      expect(await unlockPassword("alice")).toBe("shared-secret");
    });

    test("the passkeys are independent: with only the first at hand it opens too", async () => {
      authenticator = installFakeAuthenticator();
      await savePassword("alice", "pw");
      authenticator.useDevice(1);
      await addPasskey("alice");
      authenticator.unplug(1); // the backup key isn't plugged in
      expect(await unlockPassword("alice")).toBe("pw");
    });

    test("the same authenticator can't be added twice, and a failed or cancelled add changes nothing", async () => {
      authenticator = installFakeAuthenticator();
      await savePassword("alice", "pw");
      const snapshot = stored("alice");

      // Adding from the very same authenticator: it refuses (the existing one is excluded).
      expect((await fail(addPasskey("alice"))).kind).toBe("duplicate");
      expect(stored("alice")).toBe(snapshot);

      authenticator.cancelNext(); // the unlock step
      expect((await fail(addPasskey("alice"))).kind).toBe("cancelled");
      expect(stored("alice")).toBe(snapshot);
    });

    test("a passkey can be removed on its own; removing the last one removes the vault", async () => {
      authenticator = installFakeAuthenticator();
      await savePassword("alice", "pw");
      authenticator.useDevice(1);
      await addPasskey("alice");
      const [first, second] = listPasskeys("alice");

      removePasskey("alice", first!.credentialId);
      expect(listPasskeys("alice").map(p => p.credentialId)).toEqual([second!.credentialId]);
      expect(await unlockPassword("alice")).toBe("pw"); // the remaining one still works

      removePasskey("alice", second!.credentialId);
      expect(hasVault("alice")).toBe(false);
      expect(stored("alice")).toBeNull();
    });

    test("a vault written before there were lists (one passkey, v1) still opens and can get a second passkey", async () => {
      authenticator = installFakeAuthenticator();
      await savePassword("alice", "legacy");
      const { credentialId, salt, iv, ciphertext } = JSON.parse(stored("alice")!).entries[0];
      localStorage.setItem("psmail.passkeyVault.alice", JSON.stringify({ v: 1, credentialId, salt, iv, ciphertext })); // the old format

      expect(hasVault("alice")).toBe(true);
      expect(await unlockPassword("alice")).toBe("legacy");
      authenticator.useDevice(1);
      await addPasskey("alice"); // an old-format vault can be extended
      expect(listPasskeys("alice")).toHaveLength(2);
      authenticator.unplug(0);
      expect(await unlockPassword("alice")).toBe("legacy");
    });
  });
});
