#!/usr/bin/env bun
import { ApiClient, CliApiError } from "./client";
import { parseFlags, promptHidden } from "./args";
import { renderProgress } from "./progress";

async function resolvePassword(flags: Record<string, string | boolean>, flagName: string, envVar: string, promptText: string) {
  const flagValue = flags[flagName];
  if (typeof flagValue === "string") return flagValue;
  if (process.env[envVar]) return process.env[envVar]!;
  return promptHidden(promptText);
}

async function loginFromFlags(client: ApiClient, flags: Record<string, string | boolean>) {
  const username = typeof flags.user === "string" ? flags.user : "default";
  const password = await resolvePassword(flags, "password", "PSMAIL_PASSWORD", `Password for "${username}": `);
  const { token } = await client.login(username, password);
  client.setToken(token);
  return { username, password };
}

async function cmdUserCreate(argv: string[]) {
  const { positionals, flags } = parseFlags(argv);
  const username = positionals[0];
  if (!username) throw new Error("Usage: psmail user create <username> [--password <pw>]");

  const password = await resolvePassword(flags, "password", "PSMAIL_PASSWORD", `Password for new user "${username}" (leave empty for none): `);
  const client = new ApiClient(typeof flags.url === "string" ? flags.url : undefined);
  const user = await client.createUser(username, password);
  console.log(`Created user #${user.id} "${user.username}"`);
}

async function cmdAccountAdd(argv: string[]) {
  const { flags } = parseFlags(argv);
  const client = new ApiClient(typeof flags.url === "string" ? flags.url : undefined);
  await loginFromFlags(client, flags);

  const required = ["email", "imap-host", "imap-port", "imap-username", "smtp-host", "smtp-port", "smtp-username"];
  for (const field of required) {
    if (typeof flags[field] !== "string") throw new Error(`Missing required --${field}`);
  }

  const imapPassword = await resolvePassword(flags, "imap-password", "PSMAIL_IMAP_PASSWORD", "IMAP password: ");
  const smtpPassword = await resolvePassword(flags, "smtp-password", "PSMAIL_SMTP_PASSWORD", "SMTP password: ");

  const account = await client.createAccount({
    email: flags.email,
    displayName: flags["display-name"],
    imapHost: flags["imap-host"],
    imapPort: Number(flags["imap-port"]),
    imapSecure: flags["imap-secure"] !== "false",
    imapUsername: flags["imap-username"],
    imapPassword,
    smtpHost: flags["smtp-host"],
    smtpPort: Number(flags["smtp-port"]),
    smtpSecure: flags["smtp-secure"] !== "false",
    smtpUsername: flags["smtp-username"],
    smtpPassword,
  });

  console.log(`Created account #${account.id} "${account.email}"`);
}

async function cmdSync(argv: string[]) {
  const { positionals, flags } = parseFlags(argv);
  const accountEmail = positionals[0];
  if (!accountEmail) throw new Error("Usage: psmail sync <account-email> [--user <username>] [--folder INBOX]");

  const client = new ApiClient(typeof flags.url === "string" ? flags.url : undefined);
  await loginFromFlags(client, flags);

  const folder = typeof flags.folder === "string" ? flags.folder : "INBOX";
  const job = await client.triggerDownload(accountEmail, folder);
  console.log(`Started download job #${job.id} for "${accountEmail}" (${folder})`);

  let finished = false;
  while (!finished) {
    const status = await client.getDownloadJob(accountEmail, job.id);

    if (status.progressTotal > 0 || status.status === "running") {
      renderProgress(status.progressCurrent, status.progressTotal);
    }

    if (status.status === "completed") {
      finished = true;
      process.stdout.write("\n");
      console.log(`Done. Downloaded ${status.progressCurrent} email(s).`);
    } else if (status.status === "failed") {
      finished = true;
      process.stdout.write("\n");
      console.error(`Sync failed: ${status.error}`);
      process.exitCode = 1;
    } else {
      await Bun.sleep(500);
    }
  }
}

function printUsage() {
  console.log(`P.S.Mail CLI

Usage:
  psmail user create <username> [--password <pw>] [--url <api-url>]
  psmail account add --user <username> [--password <pw>]
               --email <email> [--display-name <name>]
               --imap-host <host> --imap-port <port> [--imap-secure=true|false] --imap-username <user> [--imap-password <pw>]
               --smtp-host <host> --smtp-port <port> [--smtp-secure=true|false] --smtp-username <user> [--smtp-password <pw>]
               [--url <api-url>]
  psmail sync <account-email> [--user <username>] [--password <pw>] [--folder INBOX] [--url <api-url>]

Env vars: PSMAIL_API_URL, PSMAIL_PASSWORD, PSMAIL_IMAP_PASSWORD, PSMAIL_SMTP_PASSWORD
`);
}

async function main() {
  const [group, subcommand, ...rest] = process.argv.slice(2);

  try {
    if (group === "user" && subcommand === "create") {
      await cmdUserCreate(rest);
    } else if (group === "account" && subcommand === "add") {
      await cmdAccountAdd(rest);
    } else if (group === "sync") {
      await cmdSync([subcommand, ...rest].filter((x): x is string => x !== undefined));
    } else {
      printUsage();
      process.exitCode = group ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof CliApiError) {
      console.error(`API error (${error.status}): ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
