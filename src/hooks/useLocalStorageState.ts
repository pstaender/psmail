import { useCallback, useState } from "react";

/** Like useState, but the value is seeded from (and persisted to) localStorage under `key`. */
export function useLocalStorageState<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const setPersisted = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private browsing, storage quota, etc. — the value still works for this session.
      }
    },
    [key]
  );

  return [value, setPersisted];
}
