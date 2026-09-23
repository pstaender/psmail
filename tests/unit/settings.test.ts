import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettingsPath } from "../../src/server/config/paths";
import { loadSettings, resetSettingsCache, updateSettings } from "../../src/server/config/settings";

describe("settings.json: hostname (local traffic only by default)", () => {
  const originalDir = process.env.PSMAIL_CONFIG_DIR;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "psmail-settings-"));
    process.env.PSMAIL_CONFIG_DIR = dir;
    resetSettingsCache();
  });
  afterEach(() => {
    if (originalDir === undefined) delete process.env.PSMAIL_CONFIG_DIR;
    else process.env.PSMAIL_CONFIG_DIR = originalDir;
    resetSettingsCache();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a brand-new settings.json gets hostname 127.0.0.1 written in, on disk and in what's returned", async () => {
    const settings = await loadSettings();
    expect(settings.hostname).toBe("127.0.0.1");
    expect(JSON.parse(await Bun.file(getSettingsPath()).text())).toMatchObject({ hostname: "127.0.0.1" });
  });

  test("an existing settings.json from before this setting existed keeps no hostname — not retroactively restricted", async () => {
    writeFileSync(getSettingsPath(), JSON.stringify({ port: 3001, sessionTtlSeconds: 43200 }));
    resetSettingsCache();
    const settings = await loadSettings();
    expect(settings.hostname).toBeUndefined();
    // Saving again (e.g. changing an unrelated option) doesn't add it either.
    await updateSettings({ port: 3002 });
    expect((await loadSettings()).hostname).toBeUndefined();
  });

  test("it can be changed with updateSettings, like any other setting", async () => {
    await loadSettings(); // creates it with the 127.0.0.1 default
    expect((await updateSettings({ hostname: "0.0.0.0" })).hostname).toBe("0.0.0.0");
  });
});
