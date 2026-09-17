/** A thin, draggable vertical divider between two columns. Wire `onPointerDown` to a useResizableWidth's `startResize`. */
export function ResizeHandle({ onPointerDown }: { onPointerDown: (event: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/30 active:bg-primary/50"
    />
  );
}
