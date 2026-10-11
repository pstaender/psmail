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

const dialog = () => document.querySelector('[data-slot="dialog-content"]')!;

describe("ComposeDialog: maximize / restore", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("Maximize covers the screen, Restore brings the window back", () => {
    renderCompose();
    expect(dialog().classList.contains("w-screen")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(dialog().classList.contains("w-screen")).toBe(true);
    expect(dialog().classList.contains("h-dvh")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(dialog().classList.contains("w-screen")).toBe(false);
    expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
  });

  test("the next compose window opens the way the last one was left", () => {
    renderCompose();
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    cleanup();

    renderCompose();
    expect(dialog().classList.contains("w-screen")).toBe(true);
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });
});
