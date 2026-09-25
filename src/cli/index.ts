#!/usr/bin/env bun
import { ApiClient, CliApiError, type ClassifyEvent, type SummarizeEvent } from "./client";
import { parseFlags, promptHidden } from "./args";
import { renderProgress } from "./progress";

async function resolvePassword(flags: Record<string, string | boolean>, flagName: string, envVar: string, promptText: string) {
  const flagValue = flags[flagName];
  if (typeof flagValue === "string") return flagValue;
  if (process.env[envVar] !== undefined) return process.env[envVar]!;
  return promptHidden(promptText);
}

async function loginFromFlags(client: ApiClient, flags: Record<string, string | boolean>) {
  const username = typeof flags.user === "string" ? flags.user : "default";
  const password = await resolvePassword(flags, "password", "PSMAIL_PASSWORD", `Password for "${username}": `);
  const { token } = await client.login(username, password);
  client.setToken(token);
  return { username, password };
}

/**
 * Signs in for a command that works on the given accounts and says which profile that was. Without `--user` the server is asked
 * which profile has the account(s) — that one is used (`default` only when it is one of them, or when no account is named, i.e. all).
 * With `--user` that profile is used, and if it doesn't have the account the error names the profile that does.
 * Returns the profile's name.
 */
export async function signInForAccounts(client: ApiClient, flags: Record<string, string | boolean>, wanted: string[]): Promise<string> {
  const ownersOf = async (address: string) => (await client.accountOwners(address)).map(owner => owner.username);

  // Who has which of the named accounts (looked up before signing in, so the right profile is asked for its password).
  const owners = new Map<string, string[]>();
  for (const address of wanted) owners.set(address, await ownersOf(address));
  const nobody = wanted.filter(address => owners.get(address)!.length === 0);
  if (nobody.length > 0) throw new Error(`No profile has the account ${nobody.join(", ")}.`);

  let username: string;
  if (typeof flags.user === "string") {
    username = flags.user;
    const lacking = wanted.filter(address => !owners.get(address)!.includes(username));
    if (lacking.length > 0) {
      const hints = lacking.map(address => `${address} belongs to ${owners.get(address)!.map(name => `"${name}"`).join(" / ")}`);
      throw new Error(`"${username}" has no account ${lacking.join(", ")}: ${hints.join("; ")} — use --user ${owners.get(lacking[0]!)![0]}.`);
    }
  } else if (wanted.length === 0) {
    username = "default";
  } else {
    // Profiles that have every named account; "default" wins when it is one of them.
    const candidates = owners.get(wanted[0]!)!.filter(name => wanted.every(address => owners.get(address)!.includes(name)));
    if (candidates.length === 0) {
      throw new Error(`These accounts belong to different profiles: ${wanted.map(address => `${address} → ${owners.get(address)!.join(" / ")}`).join("; ")}. Run the command once per profile with --user.`);
    }
    if (candidates.length > 1 && !candidates.includes("default")) {
      throw new Error(`${wanted.join(", ")} exist in several profiles (${candidates.join(", ")}) — choose one with --user <username>.`);
    }
    username = candidates.includes("default") ? "default" : candidates[0]!;
    console.log(`${wanted.length === 1 ? `The account ${wanted[0]} belongs` : "The accounts belong"} to the profile "${username}".`);
  }

  await loginFromFlags(client, { ...flags, user: username });
  return username;
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
/**
 * `psmail imap find-message-id <account-email> <folder> <message-id>` — a diagnostic: asks the server directly
 * whether a message with this Message-ID exists in `folder`, and under what UID. Useful when a message another
 * mail client shows never shows up in psmail: a normal sync only asks for UIDs newer than the highest one already
 * stored, so a message whose real UID turns out to be lower than that would never be found by it, however many
 * times it runs — this bypasses the sync and asks the server. Read-only; nothing gets written locally.
 */
async function cmdImap(subcommand: string | undefined, argv: string[]) {
  const { positionals, flags } = parseFlags(argv);
  const url = typeof flags.url === "string" ? flags.url : undefined;
  const client = new ApiClient(url);

  if (subcommand !== "find-message-id") {
    throw new Error("Usage: psmail imap find-message-id <account-email> <folder> <message-id> [--user <username>] [--password <pw>] [--url <api-url>]");
  }
  const [accountEmail, folder, messageId] = positionals;
  if (!accountEmail || !folder || !messageId) {
    throw new Error("Usage: psmail imap find-message-id <account-email> <folder> <message-id> [--user <username>] [--password <pw>] [--url <api-url>]");
  }

  const username = await signInForAccounts(client, flags, [accountEmail]);
  console.log(`Signed in to ${url ?? process.env.PSMAIL_API_URL ?? "http://localhost:3001"} as "${username}".`);
  console.log(`Searching "${folder}" on ${accountEmail} for Message-ID ${messageId} …`);

  const { found } = await client.findMessageId(accountEmail, folder, messageId);
  if (found.length === 0) {
    console.log(`Not found. The server's "${folder}" genuinely has no message with that Message-ID right now.`);
    return;
  }
  for (const message of found) {
    console.log(`  UID ${message.uid}  ${message.date ?? "(no date)"}  ${(message.subject ?? "(no subject)").slice(0, 80)}  (${message.size} bytes)`);
  }
  console.log(`\n${found.length} message(s) found. If psmail's own highest known UID for "${folder}" is already above ${Math.max(...found.map(m => m.uid))}, a normal sync will never pick this up on its own.`);
}

async function cmdImbox(subcommand: string | undefined, argv: string[]) {
  const { positionals, flags } = parseFlags(argv);
  // `--force a@b.example` would read the address as the flag's value; these flags take none.
  for (const name of ["force", "verbose"]) if (typeof flags[name] === "string") positionals.push(flags[name] as string);
  const force = flags.force !== undefined && flags.force !== false;
  const verbose = flags.verbose !== undefined && flags.verbose !== false;

  const url = typeof flags.url === "string" ? flags.url : undefined;
  const client = new ApiClient(url);
  // classify takes account addresses; explain takes one address followed by a message id.
  const wanted = subcommand === "explain" ? positionals.slice(0, 1) : subcommand === "classify" ? positionals : [];
  const username = await signInForAccounts(client, flags, wanted);
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
/**
 * Runs one streamed summarize call and, if the connection itself drops mid-run (a network hiccup, or just a very long total
 * duration — the whole batch rides one HTTP response) — as opposed to a real answer from the server, a `CliApiError`, which is
 * never retried — reconnects and resumes instead of losing everything done so far. An account that already finished (its
 * `account-done` arrived) isn't asked for again; within an account that hadn't finished, `/api/ai/summarize` itself only
 * redoes messages without a summary unless `--force`, so a resumed run picks up close to where it left off. Gives up after
 * `maxReconnects` drops in a row (a server that is genuinely gone, not just a blip). Totals are the true grand total across every
 * attempt, added up from each account's own `account-done` (which fires exactly once per account, whichever attempt did it).
 */
export async function runSummarizeWithReconnect(
  attempt: (accounts: string[] | undefined, onEvent: (event: SummarizeEvent) => void) => Promise<SummarizeEvent & { type: "done" }>,
  initialAccounts: string[] | undefined,
  onEvent: (event: SummarizeEvent) => void,
  options: { onReconnect?: (message: string, attemptNumber: number) => void; sleep?: (ms: number) => Promise<void>; maxReconnects?: number } = {}
): Promise<{ summarized: number; failed: number; reconnects: number }> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const maxReconnects = options.maxReconnects ?? 20;
  let accountsToRequest = initialAccounts;
  const finishedAccounts = new Set<string>();
  // A plain object, not a bare `let`: reassigned only from the `track` closure below, and TypeScript's narrowing loses track of a
  // `let`'s type across a closure invoked through an opaque callback parameter — this keeps `resolved.accounts` typed correctly.
  const resolved: { accounts: string[] | null } = { accounts: null };
  let reconnects = 0;
  let summarized = 0;
  let failed = 0;

  const track = (event: SummarizeEvent) => {
    onEvent(event);
    if (event.type === "start") resolved.accounts = event.accounts;
    if (event.type === "account-done" && !finishedAccounts.has(event.account)) {
      finishedAccounts.add(event.account);
      summarized += event.summarized;
      failed += event.failed;
    }
  };

  for (;;) {
    try {
      await attempt(accountsToRequest, track);
      return { summarized, failed, reconnects };
    } catch (error) {
      if (error instanceof CliApiError) throw error; // the server answered with a real error — retrying won't fix that
      reconnects++;
      if (reconnects > maxReconnects) throw error;
      options.onReconnect?.(error instanceof Error ? error.message : String(error), reconnects);
      if (resolved.accounts !== null) accountsToRequest = resolved.accounts.filter(a => !finishedAccounts.has(a));
      await sleep(Math.min(reconnects, 10) * 1000);
    }
  }
}

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
  const username = await signInForAccounts(client, flags, positionals);
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
        } else if (event.timedOut) {
          console.log(`  TIMED OUT   ${label}\n              ${event.error} — logged, moving on`);
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

  const { summarized, failed, reconnects } = await runSummarizeWithReconnect(
    (accounts, handler) => client.summarizeStream({ accounts, folder, force, verbose }, handler),
    positionals.length > 0 ? positionals : undefined,
    onEvent,
    {
      onReconnect: (message, attempt) =>
        console.error(`\nConnection to the server was lost (${message}). Reconnecting and resuming (attempt ${attempt}) …`),
    }
  );
  if (reconnects > 0) {
    console.log(`\nReconnected ${reconnects} time(s) after the connection dropped: ${summarized} message(s) summarized in total across the whole run${failed > 0 ? `, ${failed} failed` : ""}.`);
    if (failed > 0) process.exitCode = 1;
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
  psmail imbox classify [account-email ...] [--force] [--verbose] [--user <username>] [--password <pw>] [--url <api-url>]
               classifies stored mail as important / not important (default: every account; --force redoes messages that have a verdict;
               --verbose prints every message with its verdict and main reasons)
  psmail imbox explain <account-email> <message-id> [--user <username>] [--password <pw>] [--url <api-url>]
  psmail imap find-message-id <account-email> <folder> <message-id> [--user <username>] [--password <pw>] [--url <api-url>]
               diagnostic: asks the server directly whether a message with this Message-ID exists in <folder> and under what
               UID — for when another mail client shows a message that psmail's own sync never picks up (a sync only asks for
               UIDs newer than the highest one already stored, so a message whose real UID is lower than that never surfaces)
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
    } else if (group === "imap") {
      await cmdImap(subcommand, rest);
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
