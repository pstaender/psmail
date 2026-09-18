import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Editor } from "tiny-markdown-editor";
import { cn } from "@/lib/utils";
import "./tinyMarkdownEditor.css";

export interface MarkdownEditorHandle {
  focus: () => void;
}

/**
 * TinyMDE (https://github.com/jefago/tiny-markdown-editor) without its command bar — just the
 * inline-formatting editor. `initialValue` seeds the editor once on mount; after that TinyMDE owns
 * its own content/undo history and every edit is reported via `onChange`. This is intentionally not
 * a fully controlled input: re-syncing `value` on every render would fight the editor's own cursor
 * position and undo stack. Callers that need a fresh editor (a different draft) should remount this
 * component (e.g. via `key`) rather than expect prop-driven content updates.
 *
 * `readOnly` renders the exact same inline-formatted view (bold, headers, lists, de-emphasized
 * markup characters, ...) with editing turned off — TinyMDE has no built-in read-only mode since
 * its rendering IS the editing surface, so this just disables the underlying contenteditable
 * surface's native typing/IME instead of falling back to a plain/raw text dump.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, {
  initialValue: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  readOnly?: boolean;
}>(function MarkdownEditor({ initialValue, onChange, placeholder, className, "aria-label": ariaLabel, readOnly }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.e?.focus(),
  }));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const editor = new Editor({ element: container, content: initialValue, placeholder });
    editorRef.current = editor;
    // role/aria-label belong on the actual contenteditable surface TinyMDE creates (a child
    // of `container`), not the wrapper div — that's what a screen reader will focus into.
    if (ariaLabel) editor.e?.setAttribute("aria-label", ariaLabel);
    if (readOnly) {
      editor.e?.setAttribute("contenteditable", "false");
      editor.e?.setAttribute("aria-readonly", "true");
      editor.e?.setAttribute("tabindex", "-1");
    }

    const handleChange = ({ content }: { content: string }) => onChangeRef.current?.(content);
    editor.addEventListener("change", handleChange);

    return () => {
      editor.removeEventListener("change", handleChange);
      editor.destroy();
      editorRef.current = null;
    };
    // Mount once — see the doc comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={containerRef} className={cn("psmail-markdown-editor", readOnly && "psmail-markdown-editor--readonly", className)} />
  );
});
