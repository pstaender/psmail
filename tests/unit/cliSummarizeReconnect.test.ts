import { describe, expect, test } from "bun:test";
import { runSummarizeWithReconnect } from "../../src/cli/index";
import { CliApiError } from "../../src/cli/client";
import type { SummarizeEvent } from "../../src/cli/client";

/** A minimal "account-done" event, the only kind the reconnect logic reads besides "start". */
function accountDone(account: string, summarized: number, failed = 0): SummarizeEvent {
  return { type: "account-done", account, examined: summarized + failed, summarized, failed };
}
function start(accounts: string[]): SummarizeEvent {
  return { type: "start", accounts, folder: null, force: false };
}
function done(): SummarizeEvent & { type: "done" } {
  return { type: "done", results: [], seconds: 0 };
}

describe("runSummarizeWithReconnect", () => {
  test("no drop: calls attempt once with the initial accounts, sums account-done totals, no reconnects", async () => {
    const calls: (string[] | undefined)[] = [];
    const events: SummarizeEvent[] = [];
    const result = await runSummarizeWithReconnect(
      async (accounts, onEvent) => {
        calls.push(accounts);
        onEvent(start(["a@x.com", "b@x.com"]));
        onEvent(accountDone("a@x.com", 3));
        onEvent(accountDone("b@x.com", 2, 1));
        return done();
      },
      ["a@x.com", "b@x.com"],
      e => events.push(e)
    );
    expect(calls).toEqual([["a@x.com", "b@x.com"]]);
    expect(result).toEqual({ summarized: 5, failed: 1, reconnects: 0 });
    expect(events.filter(e => e.type === "account-done")).toHaveLength(2);
  });

  test("a dropped connection is retried, excluding accounts that already finished; totals add up across attempts", async () => {
    const calls: (string[] | undefined)[] = [];
    let attemptNumber = 0;
    const reconnectLog: [string, number][] = [];
    const result = await runSummarizeWithReconnect(
      async (accounts, onEvent) => {
        calls.push(accounts);
        attemptNumber++;
        if (attemptNumber === 1) {
          onEvent(start(["a@x.com", "b@x.com", "c@x.com"]));
          onEvent(accountDone("a@x.com", 4));
          throw Object.assign(new Error("The socket connection was closed unexpectedly."), { name: "ConnectionClosed" });
        }
        onEvent(start(["b@x.com", "c@x.com"]));
        onEvent(accountDone("b@x.com", 2));
        onEvent(accountDone("c@x.com", 1, 1));
        return done();
      },
      ["a@x.com", "b@x.com", "c@x.com"],
      () => {},
      { onReconnect: (message, n) => reconnectLog.push([message, n]), sleep: async () => {} }
    );
    expect(calls).toEqual([
      ["a@x.com", "b@x.com", "c@x.com"],
      ["b@x.com", "c@x.com"], // a@x.com already finished before the drop — not asked for again
    ]);
    expect(reconnectLog).toEqual([["The socket connection was closed unexpectedly.", 1]]);
    expect(result).toEqual({ summarized: 4 + 2 + 1, failed: 1, reconnects: 1 });
  });

  test("a real error from the server (CliApiError) is never retried", async () => {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw new CliApiError(409, 'No "summarize" skill is set up yet');
    };
    await expect(runSummarizeWithReconnect(attempt, undefined, () => {}, { sleep: async () => {} })).rejects.toThrow(/summarize.*skill/);
    expect(calls).toBe(1);
  });

  test("gives up after maxReconnects drops in a row, without looping forever", async () => {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw new Error("connection reset");
    };
    await expect(runSummarizeWithReconnect(attempt, undefined, () => {}, { maxReconnects: 3, sleep: async () => {} })).rejects.toThrow(
      /connection reset/
    );
    expect(calls).toBe(4); // the first try plus 3 retries
  });

  test("before the first `start` event ever arrives, a retry re-requests the same (unresolved) account list", async () => {
    const calls: (string[] | undefined)[] = [];
    let attemptNumber = 0;
    const result = await runSummarizeWithReconnect(
      async (accounts, onEvent) => {
        calls.push(accounts);
        attemptNumber++;
        if (attemptNumber < 2) throw new Error("refused");
        onEvent(start(["only@x.com"]));
        onEvent(accountDone("only@x.com", 1));
        return done();
      },
      ["only@x.com"],
      () => {},
      { sleep: async () => {} }
    );
    expect(calls).toEqual([["only@x.com"], ["only@x.com"]]);
    expect(result.summarized).toBe(1);
  });
});
