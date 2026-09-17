import { useCallback, useEffect, useRef, useState } from "react";

function readStoredWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw !== null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A column width, drag-resizable via `startResize` (wire to a handle's onPointerDown) and
 * persisted to localStorage once the drag ends. Only the final width is written — every
 * intermediate pointermove just updates local state, so dragging doesn't hammer localStorage.
 */
export function useResizableWidth(storageKey: string, defaultWidth: number, min: number, max: number) {
  const [width, setWidth] = useState(() => readStoredWidth(storageKey, defaultWidth));
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, value)), [min, max]);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      setWidth(clamp(dragStartWidth.current + (event.clientX - dragStartX.current)));
    },
    [clamp]
  );

  const stopResize = useCallback(() => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", stopResize);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      localStorage.setItem(storageKey, String(widthRef.current));
    } catch {
      // Private browsing, storage quota, etc. — the width still works for this session.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPointerMove, storageKey]);

  const startResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      dragStartX.current = event.clientX;
      dragStartWidth.current = widthRef.current;
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", stopResize);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onPointerMove, stopResize]
  );

  // Belt-and-suspenders cleanup if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", stopResize);
    };
  }, [onPointerMove, stopResize]);

  return { width, startResize };
}
