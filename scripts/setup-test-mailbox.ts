#!/usr/bin/env bun
/**
 * Spins up the Greenmail test IMAP/SMTP server (via docker/greenmail.yml),
 * appends every .eml file under testmails/<folder>/ into the matching
 * mailbox folder, then creates/points a P.S.Mail account at it and triggers
 * a sync — so the webclient has real-looking mail to test against.
 *
 * Requires the P.S.Mail API server to already be running (`bun run dev`).
 *
 * Usage:
 *   bun run scripts/setup-test-mailbox.ts [--reset] [--source testmails]
 *     [--account testmails@example.local] [--user default] [--url http://localhost:3001]
 *
 * --reset also deletes the account (and its locally synced data) and empties
 * the IMAP folders first, so re-running the script gives a clean slate
 * instead of piling up duplicate messages.
 */
import { readdir } from "node:fs/promises";
import { connect } from "node:net";
import { basename, join } from "node:path";
import { parseFlags } from "../src/cli/args";
import { ApiClient, CliApiError } from "../src/cli/client";
import { renderProgress } from "../src/cli/progress";
import { createImapClient } from "../src/server/services/imap";
import { parseMessage } from "../src/server/services/messageParser";

const GREENMAIL_COMPOSE_FILE = "docker/greenmail.yml";
const IMAP_HOST = "127.0.0.1";
const IMAP_PORT = 3143;
const SMTP_HOST = "127.0.0.1";
const SMTP_PORT = 3025;
const IMAP_USER = "psmail";
const IMAP_PASSWORD = "psmail-test-pw";

interface Options {
  reset: boolean;
  source: string;
  accountEmail: string;
  username: string;
  apiUrl: string;
}

function parseOptions(argv: string[]): Options {
  const { flags } = parseFlags(argv);
  return {
    reset: flags.reset === true || flags.reset === "true",
    source: typeof flags.source === "string" ? flags.source : "testmails",
    accountEmail: typeof flags.account === "string" ? flags.account : "testmails@example.local",
    username: typeof flags.user === "string" ? flags.user : "default",
    apiUrl: typeof flags.url === "string" ? flags.url : (process.env.PSMAIL_API_URL ?? "http://localhost:3001"),
  };
}

function checkPort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function ensureGreenmailRunning() {
  if (await checkPort(IMAP_HOST, IMAP_PORT, 500)) {
    console.log("Greenmail is already running.");
    return;
  }

  const dockerCheck = await Bun.$`which docker`.quiet().nothrow();
  if (dockerCheck.exitCode !== 0) {
    console.error(
      `Docker isn't available, and nothing is listening on ${IMAP_HOST}:${IMAP_PORT}.\n` +
        `Install Docker, or start a compatible IMAP+SMTP test server yourself matching ${GREENMAIL_COMPOSE_FILE}\n` +
        `(IMAP ${IMAP_HOST}:${IMAP_PORT}, SMTP ${SMTP_HOST}:${SMTP_PORT}, user "${IMAP_USER}" / "${IMAP_PASSWORD}"), then re-run this script.`
    );
    process.exit(1);
  }

  console.log("Starting Greenmail via docker compose...");
  const up = await Bun.$`docker compose -f ${GREENMAIL_COMPOSE_FILE} up -d`.nothrow();
  if (up.exitCode !== 0) {
    console.error("Failed to start Greenmail. See docker output above.");
    process.exit(1);
  }

  console.log("Waiting for Greenmail's IMAP port to accept connections...");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await checkPort(IMAP_HOST, IMAP_PORT, 1000)) return;
    await Bun.sleep(500);
  }
  console.error("Timed out waiting for Greenmail to become ready.");
  process.exit(1);
}

/** testmails/<folder>/*.eml -> Map<IMAP folder path, absolute .eml file paths>. "inbox" is mapped to "INBOX". */
async function discoverFolders(sourceDir: string): Promise<Map<string, string[]>> {
  const folders = new Map<string, string[]>();

  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch {
    console.error(`Source directory "${sourceDir}" does not exist.`);
    process.exit(1);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(sourceDir, entry.name);
    const files = (await readdir(dirPath)).filter(f => f.toLowerCase().endsWith(".eml")).sort();
    if (files.length === 0) continue;

    const imapFolder = entry.name.toLowerCase() === "inbox" ? "INBOX" : entry.name;
    folders.set(imapFolder, files.map(f => join(dirPath, f)));
  }

  return folders;
}

async function appendTestMails(folders: Map<string, string[]>, reset: boolean) {
  const client = createImapClient({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    username: IMAP_USER,
    password: IMAP_PASSWORD,
  });

  await client.connect();
  try {
    for (const [folder, files] of folders) {
      if (folder !== "INBOX") {
        await client.mailboxCreate(folder).catch(() => {});
      }
      const mailbox = await client.mailboxOpen(folder);

      if (reset && mailbox.exists > 0) {
        console.log(`Clearing ${mailbox.exists} existing message(s) from "${folder}"...`);
        await client.messageDelete("1:*");
      }

      console.log(`Appending ${files.length} message(s) into "${folder}"...`);
      for (const [i, filePath] of files.entries()) {
        const buffer = Buffer.from(await Bun.file(filePath).arrayBuffer());

        let idate: Date | undefined;
        try {
          const parsed = await parseMessage(buffer);
          if (parsed.date) idate = new Date(parsed.date);
        } catch {
          // Fall back to the append's default (current time) if the message doesn't parse cleanly.
        }

        await client.append(folder, buffer, [], idate);
        process.stdout.write(`\r  ${i + 1}/${files.length}: ${basename(filePath)}`.padEnd(90));
      }
      process.stdout.write("\n");
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function ensureApiReachable(baseUrl: string) {
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    if (!res.ok) throw new Error();
  } catch {
    console.error(`Could not reach the P.S.Mail API at ${baseUrl}.\nStart it first: bun run dev`);
    process.exit(1);
  }
}

async function setupAccount(client: ApiClient, options: Options): Promise<void> {
  const password = process.env.PSMAIL_PASSWORD ?? "";

  let token: string;
  try {
    token = (await client.login(options.username, password)).token;
  } catch (err) {
    if (err instanceof CliApiError && err.status === 404) {
      console.log(`User "${options.username}" doesn't exist yet, creating it...`);
      await client.createUser(options.username, password);
      token = (await client.login(options.username, password)).token;
    } else {
      throw err;
    }
  }
  client.setToken(token);

  if (options.reset) {
    try {
      await client.deleteAccount(options.accountEmail);
      console.log(`Removed existing account "${options.accountEmail}" and its locally synced data.`);
    } catch (err) {
      if (!(err instanceof CliApiError && err.status === 404)) throw err;
    }
  }

  try {
    await client.createAccount({
      email: options.accountEmail,
      displayName: "Test mailbox",
      imapHost: IMAP_HOST,
      imapPort: IMAP_PORT,
      imapSecure: false,
      imapUsername: IMAP_USER,
      imapPassword: IMAP_PASSWORD,
      smtpHost: SMTP_HOST,
      smtpPort: SMTP_PORT,
      smtpSecure: false,
      smtpUsername: IMAP_USER,
      smtpPassword: IMAP_PASSWORD,
    });
    console.log(`Created P.S.Mail account "${options.accountEmail}".`);
  } catch (err) {
    if (err instanceof CliApiError && err.status === 409) {
      console.log(`Account "${options.accountEmail}" already exists, continuing.`);
    } else {
      throw err;
    }
  }
}

async function syncFolders(client: ApiClient, accountEmail: string, folders: string[]) {
  for (const folder of folders) {
    console.log(`\nSyncing "${folder}"...`);
    const job = await client.triggerDownload(accountEmail, folder);

    let finished = false;
    while (!finished) {
      const status = await client.getDownloadJob(accountEmail, job.id);
      if (status.progressTotal > 0 || status.status === "running") {
        renderProgress(status.progressCurrent, status.progressTotal, "Syncing");
      }

      if (status.status === "completed") {
        finished = true;
        process.stdout.write("\n");
        console.log(`  Downloaded ${status.progressCurrent} message(s).`);
      } else if (status.status === "failed") {
        finished = true;
        process.stdout.write("\n");
        console.error(`  Sync of "${folder}" failed: ${status.error}`);
        process.exitCode = 1;
      } else {
        await Bun.sleep(400);
      }
    }
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));

  await ensureGreenmailRunning();

  const folders = await discoverFolders(options.source);
  if (folders.size === 0) {
    console.error(`No .eml files found under "${options.source}/<folder>/*.eml".`);
    process.exit(1);
  }

  await appendTestMails(folders, options.reset);

  await ensureApiReachable(options.apiUrl);
  const client = new ApiClient(options.apiUrl);
  await setupAccount(client, options);
  await syncFolders(client, options.accountEmail, [...folders.keys()]);

  console.log(
    `\nDone. Open ${options.apiUrl}, sign in as "${options.username}", and open account "${options.accountEmail}".`
  );
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { discoverFolders };
