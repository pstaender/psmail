import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuthProvider } from "../../src/contexts/AuthContext";
import { ComposeDialog } from "../../src/components/mail/ComposeDialog";

function renderCompose() {
  return render(
    <AuthProvider>
      <ComposeDialog accountEmail="me@example.com" senderName={null} folders={[]} open onOpenChange={() => {}} initial={null} onSent={() => {}} />
    </AuthProvider>,
  );
}

function attach(...files: File[]) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

const fileOf = (name: string, type: string, size: number) => new File([new Uint8Array(size)], name, { type });

describe("ComposeDialog: offering to convert images to AVIF", () => {
  afterEach(cleanup);

  test("asks for an attached PNG, and keeping the original leaves it attached", async () => {
    renderCompose();
    attach(fileOf("screenshot.png", "image/png", 2_000), fileOf("notes.pdf", "application/pdf", 500_000));

    expect(await screen.findByText("Convert the image to AVIF?")).toBeTruthy();
    fireEvent.click(screen.getByText("Keep originals"));

    expect(screen.queryByText("Convert the image to AVIF?")).toBeNull();
    expect(screen.getByText("screenshot.png")).toBeTruthy();
    expect(screen.getByText("notes.pdf")).toBeTruthy();
  });

  test("counts several images, and doesn't ask for a small JPEG", async () => {
    renderCompose();
    attach(fileOf("small.jpg", "image/jpeg", 50_000));
    expect(screen.queryByText(/to AVIF\?/)).toBeNull();

    attach(fileOf("a.png", "image/png", 2_000), fileOf("big.jpg", "image/jpeg", 300_000));
    expect(await screen.findByText("Convert 2 images to AVIF?")).toBeTruthy();
  });
});
