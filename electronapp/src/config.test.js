const { describe, expect, test, afterEach } = require("bun:test");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { getConfigDir, getSettingsPath, readServerAddress, browsableHost } = require("./config");

describe("browsableHost", () => {
  test("maps every loopback form to localhost, so WebAuthn's RP-ID-must-be-a-domain check passes", () => {
    expect(browsableHost("0.0.0.0")).toBe("localhost");
    expect(browsableHost("127.0.0.1")).toBe("localhost");
    expect(browsableHost("::1")).toBe("localhost");
  });

  test("leaves anything else (a real hostname) alone", () => {
    expect(browsableHost("localhost")).toBe("localhost");
    expect(browsableHost("mail.example.com")).toBe("mail.example.com");
  });
});

describe("getConfigDir / getSettingsPath", () => {
  const originalDir = process.env.PSMAIL_CONFIG_DIR;
  afterEach(() => {
    if (originalDir === undefined) delete process.env.PSMAIL_CONFIG_DIR;
    else process.env.PSMAIL_CONFIG_DIR = originalDir;
  });

  test("PSMAIL_CONFIG_DIR overrides the OS default", () => {
    process.env.PSMAIL_CONFIG_DIR = "/tmp/somewhere-else";
    expect(getConfigDir()).toBe("/tmp/somewhere-else");
    expect(getSettingsPath()).toBe(join("/tmp/somewhere-else", "settings.json"));
  });
});

describe("readServerAddress", () => {
  const originalDir = process.env.PSMAIL_CONFIG_DIR;
  let dir = "";
  afterEach(() => {
    if (originalDir === undefined) delete process.env.PSMAIL_CONFIG_DIR;
    else process.env.PSMAIL_CONFIG_DIR = originalDir;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("defaults to port 5387 / 127.0.0.1 when settings.json doesn't exist", () => {
    dir = mkdtempSync(join(tmpdir(), "psmail-electron-test-"));
    process.env.PSMAIL_CONFIG_DIR = dir;
    expect(readServerAddress()).toEqual({ hostname: "127.0.0.1", port: 5387 });
  });

  test("reads the real port/hostname when settings.json has them", () => {
    dir = mkdtempSync(join(tmpdir(), "psmail-electron-test-"));
    process.env.PSMAIL_CONFIG_DIR = dir;
    writeFileSync(getSettingsPath(), JSON.stringify({ port: 9999, hostname: "0.0.0.0" }));
    expect(readServerAddress()).toEqual({ hostname: "0.0.0.0", port: 9999 });
  });

  test("falls back to the defaults for a malformed settings.json rather than crashing", () => {
    dir = mkdtempSync(join(tmpdir(), "psmail-electron-test-"));
    process.env.PSMAIL_CONFIG_DIR = dir;
    writeFileSync(getSettingsPath(), "not json");
    expect(readServerAddress()).toEqual({ hostname: "127.0.0.1", port: 5387 });
  });
});
