#!/usr/bin/env bun
/**
 * The one command that builds the P.S.Mail desktop app: `bun run tauri:build` (see the root
 * package.json). Syncs the app version from the root package.json, then hands off to the Tauri CLI,
 * which in turn runs scripts/build-sidecar.ts (via tauri.conf.json's beforeBuildCommand) to compile
 * the psmail server as the app's sidecar before packaging it.
 */
import { $ } from "bun";
import { join } from "node:path";

const tauriDir = import.meta.dir;

await $`bun run ${join(tauriDir, "scripts", "sync-version.ts")}`;
await $`bun install --frozen-lockfile`.cwd(tauriDir).nothrow();
await $`bunx tauri build`.cwd(tauriDir);
