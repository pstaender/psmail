#!/usr/bin/env bun
/**
 * The one command that builds the P.S.Mail desktop app: `bun run electron:build` (see the root
 * package.json). Syncs the app version from the root package.json, compiles the psmail server as
 * the app's sidecar, then hands off to electron-builder to package the app for this platform.
 */
import { $ } from "bun";
import { join } from "node:path";

const electronDir = import.meta.dir;

await $`bun run ${join(electronDir, "scripts", "sync-version.ts")}`;
await $`bun install --frozen-lockfile`.cwd(electronDir).nothrow();
await $`bun run ${join(electronDir, "scripts", "build-sidecar.ts")}`;
await $`bunx electron-builder --config electron-builder.yml`.cwd(electronDir);
