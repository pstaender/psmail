#!/usr/bin/env bun
/**
 * Compiles the psmail server (src/server/main.ts, including its embedded frontend — Bun's HTML-import
 * bundling runs at compile time here, see `bun build --compile` docs) into one self-contained executable,
 * and places it where Tauri expects an "external binary" (sidecar) to be: `binaries/<name>-<target-triple>`,
 * named after `bundle.externalBin` in tauri.conf.json. Tauri appends the right suffix for the platform it's
 * building for on its own; this script only ever builds for the *host* machine, which is what both
 * `beforeDevCommand` and `beforeBuildCommand` need (this repo isn't set up for cross-compiling the sidecar
 * to other targets, since Bun's cross-compiled executables can't embed HTML-import assets for a different
 * target this cleanly yet — build on each platform you want to ship for).
 *
 * Uses the `Bun.build()` JS API rather than the `bun build --compile` CLI: the project's Tailwind v4 CSS
 * (`@theme`/`@utility`/`@tailwind` at-rules, processed by bun-plugin-tailwind, registered project-wide in
 * the root bunfig.toml's `[serve.static]` — see build.ts, which uses the same plugin the same way for the
 * regular static build) only actually runs through plugins under the JS API — Bun's own docs say so
 * explicitly ("these plugins work in Bun.build()'s JS API, but not yet in the CLI"). The CLI form silently
 * drops every Tailwind-generated utility class instead of erroring, so the compiled server would still boot
 * and serve real (but near-totally unstyled) CSS — this was a real bug once shipped, not a hypothetical.
 *
 * Run directly with `bun run tauri/scripts/build-sidecar.ts`, or via `bun run tauri:build`/`tauri dev`
 * (see tauri.conf.json's beforeBuildCommand/beforeDevCommand, and the root package.json script).
 */
import tailwind from "bun-plugin-tailwind";
import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const binariesDir = join(import.meta.dir, "..", "src-tauri", "binaries");

async function hostTargetTriple(): Promise<string> {
  const output = await $`rustc -vV`.quiet().text();
  const match = output.match(/^host:\s*(\S+)/m);
  if (!match) throw new Error(`Couldn't determine the Rust host target triple from "rustc -vV":\n${output}`);
  return match[1]!;
}

const triple = await hostTargetTriple();
const exeSuffix = process.platform === "win32" ? ".exe" : "";
const outfile = join(binariesDir, `psmail-server-${triple}${exeSuffix}`);

await mkdir(binariesDir, { recursive: true });

console.log(`Compiling the psmail server for ${triple} -> ${outfile}`);
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
