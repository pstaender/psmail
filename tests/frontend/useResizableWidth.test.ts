import { beforeEach, describe, expect, test } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useResizableWidth } from "../../src/hooks/useResizableWidth";

function drag(startResize: (event: any) => void, startX: number, endX: number) {
  act(() => startResize({ preventDefault: () => {}, clientX: startX } as any));
  act(() => document.dispatchEvent(new MouseEvent("pointermove", { clientX: endX }) as any));
  act(() => document.dispatchEvent(new MouseEvent("pointerup") as any));
}

describe("useResizableWidth", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("defaults to the given width when nothing is stored", () => {
    const { result } = renderHook(() => useResizableWidth("test.width", 300, 100, 600));
    expect(result.current.width).toBe(300);
  });

  test("reads a previously stored width on mount", () => {
    localStorage.setItem("test.width", "350");
    const { result } = renderHook(() => useResizableWidth("test.width", 300, 100, 600));
    expect(result.current.width).toBe(350);
  });

  test("dragging updates the width live and persists the final value on pointerup", () => {
    const { result } = renderHook(() => useResizableWidth("test.width", 300, 100, 600));

    drag(result.current.startResize, 500, 560); // +60px

    expect(result.current.width).toBe(360);
    expect(localStorage.getItem("test.width")).toBe("360");
  });

  test("clamps to the given min/max range", () => {
    const { result } = renderHook(() => useResizableWidth("test.width", 300, 100, 600));

    drag(result.current.startResize, 500, 0); // -500px, far past min
    expect(result.current.width).toBe(100);

    drag(result.current.startResize, 500, 5000); // +4500px, far past max
    expect(result.current.width).toBe(600);
  });

  test("a later mount picks up the persisted width (simulating a page reload)", () => {
    const { result: first } = renderHook(() => useResizableWidth("test.width", 300, 100, 600));
    drag(first.current.startResize, 500, 540);
    expect(first.current.width).toBe(340);

    const { result: second } = renderHook(() => useResizableWidth("test.width", 300, 100, 600));
    expect(second.current.width).toBe(340);
  });
});
