import { describe, expect, test } from "bun:test";
import { buildPath, HOME_ROUTE, parsePath } from "../../src/lib/routes";

const folder = (accountEmail: string, folderName: string, emailId: number | null = null) => ({
  unified: null,
  accountEmail,
  folder: folderName,
  emailId,
});

describe("deep link routes", () => {
  test("a folder is /a/<account>/<folder>/ and the Inbox is written inbox", () => {
    expect(buildPath(folder("my@email.com", "INBOX"))).toBe("/a/my@email.com/inbox/");
    expect(buildPath(folder("my@email.com", "Sent"))).toBe("/a/my@email.com/Sent/");
  });

  test("a message adds its id", () => {
    expect(buildPath(folder("my@email.com", "INBOX", 42))).toBe("/a/my@email.com/inbox/42");
  });

  test("the combined mailboxes live at / and /u/sent", () => {
    expect(buildPath(HOME_ROUTE)).toBe("/");
    expect(buildPath({ ...HOME_ROUTE, unified: "sent" })).toBe("/u/sent");
    expect(parsePath("/u/sent")).toEqual({ ...HOME_ROUTE, unified: "sent" });
    expect(parsePath("/")).toEqual(HOME_ROUTE);
  });

  test("parsing reads what building writes, for awkward folder names too", () => {
    for (const name of ["INBOX", "Sent", "[Gmail]/Sent Mail", "Work/2024", "2024", "Entwürfe", "100% done?", "a#b"]) {
      for (const id of [null, 7]) {
        const route = folder("my+tag@email.com", name, id);
        expect(parsePath(buildPath(route))).toEqual(route);
      }
    }
  });

  test("a folder's own slashes stay inside one segment, so a trailing number is always a message id", () => {
    expect(buildPath(folder("a@b.c", "Work/2024"))).toBe("/a/a@b.c/Work%2F2024/");
    expect(parsePath("/a/a@b.c/2024/")).toEqual(folder("a@b.c", "2024"));
    expect(parsePath("/a/a@b.c/2024/5")).toEqual(folder("a@b.c", "2024", 5));
  });

  test("inbox is matched in any case, the trailing slash is optional", () => {
    expect(parsePath("/a/a@b.c/Inbox")).toEqual(folder("a@b.c", "INBOX"));
    expect(parsePath("/a/a@b.c/INBOX/")).toEqual(folder("a@b.c", "INBOX"));
    expect(parsePath("/a/a%40b.c/inbox/3")).toEqual(folder("a@b.c", "INBOX", 3));
  });

  test("anything that isn't a route is the combined Inbox", () => {
    for (const path of ["/foo", "/a", "/a/a@b.c", "/a/a@b.c/inbox/abc", "/a/a@b.c/inbox/1/2", "/a/%E0%A4%A/inbox", "/u/other"]) {
      expect(parsePath(path)).toEqual(HOME_ROUTE);
    }
  });
});
