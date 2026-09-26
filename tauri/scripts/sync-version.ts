#!/usr/bin/env bun
/**
 * Keeps the Tauri app's version in lockstep with the root package.json's "version" — the one place
 * it's actually set — by rewriting the two places Tauri/Cargo read it from before every build.
 * Run standalone (`bun run tauri/scripts/sync-version.ts`) or via `bun run tauri:build`.
 */
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const rootPackageJsonPath = join(repoRoot, "package.json");
const tauriConfPath = join(import.meta.dir, "..", "src-tauri", "tauri.conf.json");
const cargoTomlPath = join(import.meta.dir, "..", "src-tauri", "Cargo.toml");

const { version } = (await Bun.file(rootPackageJsonPath).json()) as { version: string };
if (!version) throw new Error(`No "version" field in ${rootPackageJsonPath}`);

const tauriConf = (await Bun.file(tauriConfPath).json()) as Record<string, unknown>;
tauriConf.version = version;
await Bun.write(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");

const cargoToml = await Bun.file(cargoTomlPath).text();
const updatedCargoToml = cargoToml.replace(/^version = ".*"$/m, `version = "${version}"`);
if (updatedCargoToml === cargoToml && !cargoToml.includes(`version = "${version}"`)) {
  throw new Error(`Couldn't find a "version = ..." line to update in ${cargoTomlPath}`);
}
await Bun.write(cargoTomlPath, updatedCargoToml);

console.log(`Tauri app version set to ${version} (tauri.conf.json, Cargo.toml).`);
