#!/usr/bin/env bun
/**
 * Runs the desktop app against a freshly compiled sidecar for local development/testing —
 * `bun run tauri:dev` (see the root package.json). Not part of the packaging pipeline (that's
 * build.ts); just a convenience wrapper around `tauri dev`.
 */
import { $ } from "bun";
import { join } from "node:path";

const tauriDir = import.meta.dir;

await $`bun install --frozen-lockfile`.cwd(tauriDir).nothrow();
await $`bunx tauri dev`.cwd(tauriDir);
