import { beforeEach, describe, expect, test } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useLocalStorageState } from "../../src/hooks/useLocalStorageState";

describe("useLocalStorageState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("defaults to the given value when nothing is stored", () => {
    const { result } = renderHook(() => useLocalStorageState("test.key", false));
    expect(result.current[0]).toBe(false);
  });

  test("reads a previously stored value on mount", () => {
    localStorage.setItem("test.key", JSON.stringify(true));
    const { result } = renderHook(() => useLocalStorageState("test.key", false));
    expect(result.current[0]).toBe(true);
  });

  test("updates state and persists to localStorage", () => {
    const { result } = renderHook(() => useLocalStorageState("test.key", false));

    act(() => result.current[1](true));

    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem("test.key")).toBe("true");
  });

  test("a later mount picks up the persisted value (simulating a page reload)", () => {
    const { result: first } = renderHook(() => useLocalStorageState("test.key", false));
    act(() => first.current[1](true));

    const { result: second } = renderHook(() => useLocalStorageState("test.key", false));
    expect(second.current[0]).toBe(true);
  });
});
