#!/usr/bin/env bun
import { ApiClient, CliApiError, type ClassifyEvent, type SummarizeEvent } from "./client";
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

  const folder = typeof flags.folder === "string" ? flags.folder : undefined;
  const job = await client.triggerDownload(accountEmail, folder);
  console.log(`Started download job #${job.id} for "${accountEmail}" (${folder ?? "all folders"})`);

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

/**
 * `psmail imbox classify [account-email ...] [--force]` — classifies the stored mail of the given accounts (default: every account)
 * for the imbox; only messages without a verdict, or all of them with --force.
 * `psmail imbox explain <account-email> <message-id>` — why a message is (not) important.
 */
async function cmdImbox(subcommand: string | undefined, argv: string[]) {
  const { positionals, flags } = parseFlags(argv);
  // `--force a@b.example` would read the address as the flag's value; these flags take none.
  for (const name of ["force", "verbose"]) if (typeof flags[name] === "string") positionals.push(flags[name] as string);
  const force = flags.force !== undefined && flags.force !== false;
  const verbose = flags.verbose !== undefined && flags.verbose !== false;

  const url = typeof flags.url === "string" ? flags.url : undefined;
  const client = new ApiClient(url);
  const username = typeof flags.user === "string" ? flags.user : "default";
  await loginFromFlags(client, flags);
  console.log(`Signed in to ${url ?? process.env.PSMAIL_API_URL ?? "http://localhost:3001"} as "${username}".`);

  if (subcommand === "classify") {
    await classifyCommand(client, positionals.length > 0 ? positionals : undefined, force, verbose);
  } else if (subcommand === "explain") {
    const [accountEmail, id] = positionals;
    if (!accountEmail || !id || !Number.isInteger(Number(id))) throw new Error("Usage: psmail imbox explain <account-email> <message-id> [--user <username>]");
    const verdict = await client.explainImbox(accountEmail, Number(id));
    console.log(
      `${verdict.important ? "IMPORTANT" : "not important"} — score ${verdict.score}${verdict.ruledOut ? ` (ruled out: ${verdict.ruledOut})` : ""}${verdict.decidedBy ? ` (decided by ${verdict.decidedBy})` : ""}; stored: ${verdict.stored === null ? "not classified" : `${verdict.stored}${verdict.manual ? ", set by hand" : ""}`}`
    );
    for (const reason of verdict.reasons) {
      const points = reason.points === 0 ? "  ±0" : `${reason.points > 0 ? "+" : ""}${reason.points}`.padStart(4);
      console.log(`  ${points}  ${reason.signal}${reason.detail ? ` — ${reason.detail}` : ""}`);
    }
  } else {
    throw new Error("Usage: psmail imbox classify [account-email ...] [--force] [--verbose]  |  psmail imbox explain <account-email> <message-id>");
  }
}

/** Runs the classification and says what is going on: which accounts, how many messages each, progress, and with --verbose every verdict. */
async function classifyCommand(client: ApiClient, accounts: string[] | undefined, force: boolean, verbose: boolean) {
  const tty = Boolean(process.stdout.isTTY);
  const clearLine = () => tty && process.stdout.write("\r\x1b[K");
  let lastPrinted = 0;

  const onEvent = (event: ClassifyEvent) => {
    switch (event.type) {
      case "start":
        console.log(
          `Classifying ${event.accounts.length} account(s): ${event.accounts.join(", ") || "(none)"}` +
            (event.force ? " — all messages, again (--force)" : " — only messages without a verdict (--force for all)")
        );
        break;
      case "account":
        lastPrinted = 0;
        console.log(
          event.total === 0
            ? `\n${event.account}: nothing to classify${event.folders.length === 0 ? " (no incoming folders)" : ""}`
            : `\n${event.account}: ${event.total} message(s) to classify in ${event.folders.join(", ")}`
        );
        break;
      case "progress":
        if (tty) renderProgress(event.done, event.total, `${event.account}: ${event.important} important —`);
        else if (event.done - lastPrinted >= 2000 || event.done === event.total) {
          console.log(`  ${event.done}/${event.total} (${event.important} important)`);
          lastPrinted = event.done;
        }
        break;
      case "message": {
        clearLine();
        const verdict = event.important ? "important    " : "not important";
        const score = `${event.score > 0 ? "+" : ""}${event.score}`.padStart(6);
        console.log(`  ${verdict} ${score}  #${event.id} ${(event.subject ?? "(no subject)").slice(0, 60)} — ${event.from}${event.ruledOut ? `  [ruled out: ${event.ruledOut}]` : ""}`);
        if (event.reasons.length > 0) console.log(`                        ${event.reasons.join("; ")}`);
        break;
      }
      case "account-done":
        clearLine();
        console.log(
          event.skipped
            ? `${event.account}: skipped (${event.skipped})`
            : event.examined > 0
              ? `${event.account}: done — ${event.examined} classified: ${event.important} important, ${event.notImportant} not`
              : `${event.account}: done — nothing was classified`
        );
        break;
      case "done": {
        const examined = event.results.reduce((n, r) => n + r.examined, 0);
        const important = event.results.reduce((n, r) => n + r.important, 0);
        console.log(`\nFinished in ${event.seconds.toFixed(1)} s: ${examined} message(s) classified, ${important} important.`);
        if (examined === 0 && !force) console.log("Nothing to do — every message has a verdict already (use --force to classify them again).");
        break;
      }
    }
  };

  await client.classifyImboxStream({ accounts, force, verbose }, onEvent);
}

/**
 * `psmail summarize [account-email ...] [--folder <name>] [--force] [--verbose]` — summarizes stored mail like the Summarize button
 * (plus categories and dates when those skills exist): every account and every folder by default, only messages without a summary
 * unless --force. One AI call can take a while, so each message is announced before it is sent.
 */
async function cmdSummarize(argv: string[]) {
  const { positionals, flags } = parseFlags(argv);
  // `--force a@b.example` would read the address as the flag's value; these flags take none.
  for (const name of ["force", "verbose"]) if (typeof flags[name] === "string") positionals.push(flags[name] as string);
  const force = flags.force !== undefined && flags.force !== false;
  const verbose = flags.verbose !== undefined && flags.verbose !== false;
  if (flags.folder === true) throw new Error("--folder needs a folder name, e.g. --folder INBOX");
  const folder = typeof flags.folder === "string" ? flags.folder : undefined;

  const url = typeof flags.url === "string" ? flags.url : undefined;
  const client = new ApiClient(url);
  const username = typeof flags.user === "string" ? flags.user : "default";
  await loginFromFlags(client, flags);
  console.log(`Signed in to ${url ?? process.env.PSMAIL_API_URL ?? "http://localhost:3001"} as "${username}".`);

  const short = (text: string | null, length: number) => (text ?? "(no subject)").replace(/\s+/g, " ").slice(0, length);
  const tty = Boolean(process.stdout.isTTY);
  const clearLine = () => tty && process.stdout.write("\r\x1b[K");

  const onEvent = (event: SummarizeEvent) => {
    switch (event.type) {
      case "start":
        console.log(
          `Summarizing ${event.accounts.length} account(s): ${event.accounts.join(", ") || "(none)"} — ${event.folder ? `folder ${event.folder}` : "all folders"}` +
            (event.force ? ", all messages, again (--force)" : ", only messages without a summary (--force for all)")
        );
        break;
      case "account":
        console.log(
          event.total === 0
            ? `\n${event.account}: nothing to summarize${event.folders.length === 0 && folder ? ` (no folder "${folder}" here)` : ""}`
            : `\n${event.account}: ${event.total} message(s) to summarize in ${event.folders.join(", ")}`
        );
        break;
      case "working":
        // The AI call can take long: say which message it is on before waiting for it.
        if (tty) process.stdout.write(`\r\x1b[K  [${event.done}/${event.total}] ${event.folder}: #${event.id} ${short(event.subject, 50)} — waiting for the AI …`);
        break;
      case "message": {
        clearLine();
        const label = `#${event.id} ${event.folder}: ${short(event.subject, 60)} — ${event.from}`;
        if (event.ok) {
          const extras = [event.categories.length > 0 ? event.categories.join(", ") : "", event.dates > 0 ? `${event.dates} date(s)` : ""].filter(Boolean).join("; ");
          console.log(`  summarized  ${label} (${event.seconds.toFixed(1)} s${extras ? `; ${extras}` : ""})`);
          for (const warning of event.warnings) console.log(`              warning: ${warning}`);
          if (event.summary) console.log(event.summary.split("\n").map(line => `              ${line}`).join("\n"));
        } else if (event.skipped) {
          console.log(`  skipped     ${label} (${event.skipped})`);
        } else {
          console.log(`  FAILED      ${label}\n              ${event.error}`);
        }
        break;
      }
      case "progress":
        if (!tty && event.done % 10 === 0) console.log(`  ${event.done}/${event.total} (${event.summarized} summarized, ${event.failed} failed)`);
        break;
      case "account-done":
        console.log(
          `${event.account}: ${event.skipped ? `${event.skipped} — ` : ""}${event.examined} looked at, ${event.summarized} summarized${event.failed > 0 ? `, ${event.failed} failed` : ""}`
        );
        break;
      case "done": {
        const summarized = event.results.reduce((n, r) => n + r.summarized, 0);
        const failed = event.results.reduce((n, r) => n + r.failed, 0);
        console.log(`\nFinished in ${event.seconds.toFixed(1)} s: ${summarized} message(s) summarized${failed > 0 ? `, ${failed} failed` : ""}.`);
        if (summarized === 0 && failed === 0 && !force) console.log("Nothing to do — every message has a summary already (use --force to summarize them again).");
        if (failed > 0) process.exitCode = 1;
        break;
      }
    }
  };

  await client.summarizeStream({ accounts: positionals.length > 0 ? positionals : undefined, folder, force, verbose }, onEvent);
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
  psmail imbox classify [account-email ...] [--force] [--verbose] [--user <username>] [--password <pw>] [--url <api-url>]
               classifies stored mail as important / not important (default: every account; --force redoes messages that have a verdict;
               --verbose prints every message with its verdict and main reasons)
  psmail imbox explain <account-email> <message-id> [--user <username>] [--password <pw>] [--url <api-url>]
  psmail summarize [account-email ...] [--folder <name>] [--force] [--verbose] [--user <username>] [--password <pw>] [--url <api-url>]
               summarizes stored mail with your AI Summarize skill, like the Summarize button (also categories and dates when those skills
               exist): default every account and every folder, newest first, only messages without a summary; --folder limits it to one
               folder (e.g. INBOX), --force summarizes messages again, --verbose prints each summary. One AI call can take a while: the
               message it is waiting for is shown; a message that fails is reported and skipped, five failures in a row stop the account.

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
    } else if (group === "imbox") {
      await cmdImbox(subcommand, rest);
    } else if (group === "summarize") {
      await cmdSummarize([subcommand, ...rest].filter((x): x is string => x !== undefined));
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
