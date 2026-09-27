// Mirrors ../../src/server/config/paths.ts and settings.ts exactly — duplicated rather than shared,
// since this project intentionally has no code dependency on the main (Bun) project: Electron's main
// process runs on Electron's own bundled Node, so it can't import that TypeScript source directly.
"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_PORT = 5387;
const DEFAULT_HOSTNAME = "127.0.0.1";

function getConfigDir() {
  if (process.env.PSMAIL_CONFIG_DIR) return process.env.PSMAIL_CONFIG_DIR;

  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "psmail");
    case "win32":
      return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "psmail");
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "psmail");
  }
}

function getSettingsPath() {
  return path.join(getConfigDir(), "settings.json");
}

/** The server's own defaults (src/server/config/settings.ts) when settings.json doesn't exist yet,
 * or doesn't set these fields. */
function readServerAddress() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
    return {
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : DEFAULT_HOSTNAME,
      port: typeof parsed.port === "number" ? parsed.port : DEFAULT_PORT,
    };
  } catch {
    return { hostname: DEFAULT_HOSTNAME, port: DEFAULT_PORT };
  }
}

/** The address the *window* should load — not always the same as what the server binds to:
 * - "0.0.0.0" (every interface) isn't a valid address to connect *to*; loopback reaches the same server.
 * - A loopback IP literal ("127.0.0.1"/"::1") is a valid address to connect to, but not a valid WebAuthn
 *   relying-party ID (the spec requires a real domain string, IP addresses excluded) — passkey unlock
 *   would fail on one with a domain error. "localhost" reaches the exact same server and is accepted as
 *   a domain, so it's used for anything that resolves to loopback.
 */
function browsableHost(hostname) {
  return hostname === "0.0.0.0" || hostname === "127.0.0.1" || hostname === "::1" ? "localhost" : hostname;
}

module.exports = { getConfigDir, getSettingsPath, readServerAddress, browsableHost };
