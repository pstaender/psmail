import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider } from "../../src/contexts/AuthContext";
import { ComposeDialog, type ComposeDraft } from "../../src/components/mail/ComposeDialog";

const originalFetch = global.fetch;

function renderCompose(initial: ComposeDraft | null = null) {
  return render(
    <AuthProvider>
      <ComposeDialog accountEmail="me@example.com" senderName={null} folders={[]} open onOpenChange={() => {}} initial={initial} onSent={() => {}} />
    </AuthProvider>,
  );
}

/** The chip showing `filename`, and the preview image in it (if any). */
function previewOf(filename: string) {
  return screen.getByText(filename).closest("span")!.querySelector("img");
}

describe("ComposeDialog: previews of image attachments", () => {
  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    localStorage.clear();
  });

  test("an added image shows a preview, other files the paperclip", () => {
    renderCompose();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [new File([new Uint8Array(10)], "notes.pdf", { type: "application/pdf" }), new File([new Uint8Array(10)], "pic.webp", { type: "image/webp" })];
    fireEvent.change(input, { target: { files } });

    expect(previewOf("pic.webp")?.getAttribute("src")).toStartWith("blob:");
    expect(previewOf("notes.pdf")).toBeNull();
  });

  test("an image already on the draft is fetched with the session's token for its preview", async () => {
    localStorage.setItem("psmail.session", JSON.stringify({ token: "tok-1", userId: 1, username: "alice" }));
    const requests: { url: string; auth: string | null }[] = [];
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url === "/api/accounts") return Response.json([]);
      return new Response(new Uint8Array(10), { headers: { "content-type": "image/png" } });
    }) as typeof fetch;

    renderCompose({
      id: 7,
      attachments: [
        { id: 3, emailId: 7, filename: "shot.png", contentType: "image/png", contentId: null, isInline: false, size: 10 },
        { id: 4, emailId: 7, filename: "data.csv", contentType: "text/csv", contentId: null, isInline: false, size: 10 },
      ],
    });

    await waitFor(() => expect(previewOf("shot.png")?.getAttribute("src")).toStartWith("blob:"));
    expect(requests).toContainEqual({ url: "/api/accounts/me%40example.com/emails/7/attachments/3", auth: "Bearer tok-1" });
    expect(requests.some(r => r.url.endsWith("/attachments/4"))).toBe(false); // not an image: not downloaded
    expect(previewOf("data.csv")).toBeNull();
  });
});
