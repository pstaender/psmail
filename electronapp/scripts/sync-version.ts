#!/usr/bin/env bun
/**
 * Keeps the Electron app's version in lockstep with the root package.json's "version" — the one
 * place it's actually set — by rewriting electronapp/package.json before every build.
 * Run standalone (`bun run electronapp/scripts/sync-version.ts`) or via `bun run build`.
 */
import { join } from "node:path";

const rootPackageJsonPath = join(import.meta.dir, "..", "..", "package.json");
const electronPackageJsonPath = join(import.meta.dir, "..", "package.json");

const { version } = (await Bun.file(rootPackageJsonPath).json()) as { version: string };
if (!version) throw new Error(`No "version" field in ${rootPackageJsonPath}`);

const electronPackageJson = (await Bun.file(electronPackageJsonPath).json()) as Record<string, unknown>;
electronPackageJson.version = version;
await Bun.write(electronPackageJsonPath, JSON.stringify(electronPackageJson, null, 2) + "\n");

console.log(`Electron app version set to ${version} (electronapp/package.json).`);
