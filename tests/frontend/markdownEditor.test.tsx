import { describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { MarkdownEditor, type MarkdownEditorHandle } from "../../src/components/mail/MarkdownEditor";

describe("MarkdownEditor", () => {
  test("renders the initial value as the editor's content", () => {
    const { container, unmount } = render(<MarkdownEditor initialValue="Hello **world**" onChange={() => {}} />);

    const editable = container.querySelector(".TinyMDE");
    expect(editable).toBeTruthy();
    expect(editable!.textContent).toContain("Hello");
    expect(editable!.textContent).toContain("world");
    // TinyMDE keeps the raw markdown characters in the DOM (just styled), it doesn't strip them.
    expect(editable!.textContent).toContain("**");

    unmount();
    cleanup();
  });

  test("renders a placeholder when empty", () => {
    const { container } = render(<MarkdownEditor initialValue="" onChange={() => {}} placeholder="Write here…" />);

    const editable = container.querySelector(".TinyMDE");
    expect(editable?.classList.contains("TinyMDE_empty")).toBe(true);
    expect(editable?.getAttribute("data-placeholder")).toBe("Write here…");
  });

  test("applies aria-label to the actual contenteditable surface, not the wrapper", () => {
    const { container } = render(<MarkdownEditor initialValue="" onChange={() => {}} aria-label="Message" />);

    const wrapper = container.querySelector(".psmail-markdown-editor");
    const editable = container.querySelector(".TinyMDE");
    expect(wrapper?.getAttribute("aria-label")).toBeNull();
    expect(editable?.getAttribute("aria-label")).toBe("Message");
  });

  test("exposes focus() via ref, focusing the contenteditable surface", () => {
    const ref = createRef<MarkdownEditorHandle>();
    const { container } = render(<MarkdownEditor ref={ref} initialValue="" onChange={() => {}} />);

    const editable = container.querySelector(".TinyMDE") as HTMLElement;
    expect(document.activeElement).not.toBe(editable);

    ref.current?.focus();
    expect(document.activeElement).toBe(editable);
  });

  test("cleans up (destroy) on unmount without throwing", () => {
    const { unmount } = render(<MarkdownEditor initialValue="test" onChange={() => {}} />);
    expect(() => unmount()).not.toThrow();
  });
});
