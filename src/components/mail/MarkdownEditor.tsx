import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Editor } from "tiny-markdown-editor";
import { offsetAt } from "@/lib/compose";
import { cn } from "@/lib/utils";
import "./tinyMarkdownEditor.css";

export interface MarkdownEditorHandle {
  focus: () => void;
  /** Replaces the whole content (e.g. with an AI-refined draft). Doesn't go through the undo history's typing, but it is one undo step. */
  setContent: (content: string) => void;
  /**
   * The text last selected in the editor as character offsets into its content (`start` < `end`), or null when nothing is
   * selected. It is kept while the editor isn't focused (e.g. while a button is pressed) and forgotten when `setContent` runs.
   */
  getSelectedRange: () => { start: number; end: number } | null;
}

type Position = { row: number; col: number };

/**
 * TinyMDE (https://github.com/jefago/tiny-markdown-editor) without its command bar — just the
 * inline-formatting editor. `initialValue` seeds the editor once on mount; after that TinyMDE owns
 * its own content/undo history and every edit is reported via `onChange`. This is intentionally not
 * a fully controlled input: re-syncing `value` on every render would fight the editor's own cursor
 * position and undo stack. Callers that need a fresh editor (a different draft) should remount this
 * component (e.g. via `key`) rather than expect prop-driven content updates.
 *
 * For a non-editable rendering of markdown (e.g. showing a received message's body), use
 * RenderPureMarkdown instead — this component has no read-only mode.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, {
  initialValue: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}>(function MarkdownEditor({ initialValue, onChange, placeholder, className, "aria-label": ariaLabel }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.e?.focus(),
    setContent: content => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.setContent(content);
      // TinyMDE only updates its last selection while focused; a range into the old content would be stale.
      (editor as unknown as { lastSelection: unknown }).lastSelection = null;
    },
    getSelectedRange: () => {
      const editor = editorRef.current;
      const selection = (editor as unknown as { lastSelection: { focus: Position | null; anchor: Position | null } | null } | null)?.lastSelection;
      if (!editor || !selection?.focus || !selection.anchor) return null;
      const content = editor.getContent();
      const [a, b] = [offsetAt(content, selection.anchor), offsetAt(content, selection.focus)];
      return a === b ? null : { start: Math.min(a, b), end: Math.max(a, b) };
    },
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const editor = new Editor({ element: container, content: initialValue, placeholder });
    editorRef.current = editor;
    // role/aria-label belong on the actual contenteditable surface TinyMDE creates (a child
    // of `container`), not the wrapper div — that's what a screen reader will focus into.
    if (ariaLabel) editor.e?.setAttribute("aria-label", ariaLabel);

    const handleChange = ({ content }: { content: string }) => onChangeRef.current(content);
    editor.addEventListener("change", handleChange);

    return () => {
      editor.removeEventListener("change", handleChange);
      editor.destroy();
      editorRef.current = null;
    };
    // Mount once — see the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className={cn("psmail-markdown-editor", className)} />;
});
