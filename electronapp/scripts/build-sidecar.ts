#!/usr/bin/env bun
/**
 * Compiles the psmail server (../src/server/main.ts, including its embedded frontend — Bun's
 * HTML-import bundling runs at compile time here, see `bun build --compile` docs) into one
 * self-contained executable, placed at build/psmail-server(.exe) for Electron's main process to
 * spawn as a child process.
 *
 * Uses the `Bun.build()` JS API rather than the `bun build --compile` CLI: the project's Tailwind
 * v4 CSS (`@theme`/`@utility`/`@tailwind` at-rules, processed by bun-plugin-tailwind, registered
 * project-wide in the root bunfig.toml's `[serve.static]` — see ../../build.ts, which uses the same
 * plugin the same way for the regular static build) only actually runs through plugins under the JS
 * API — Bun's own docs say so explicitly ("these plugins work in Bun.build()'s JS API, but not yet
 * in the CLI"). The CLI form silently drops every Tailwind-generated utility class instead of
 * erroring, so the compiled server would still boot and serve real (but almost entirely unstyled)
 * CSS — this bit the Tauri build of this same app once; don't repeat it here.
 *
 * Only ever builds for the *host* machine (no cross-compiling) — ship a build made on each platform
 * you're targeting.
 */
import tailwind from "bun-plugin-tailwind";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const buildDir = join(import.meta.dir, "..", "build");
const exeSuffix = process.platform === "win32" ? ".exe" : "";
const outfile = join(buildDir, `psmail-server${exeSuffix}`);

await mkdir(buildDir, { recursive: true });

console.log(`Compiling the psmail server -> ${outfile}`);
const result = await Bun.build({
  entrypoints: [join(repoRoot, "src/server/main.ts")],
  compile: { outfile },
  plugins: [tailwind],
  minify: true,
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  throw new Error("Sidecar build failed");
}
console.log("Sidecar ready.");
