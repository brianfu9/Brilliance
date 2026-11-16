import { useState } from "react";

/**
 * React port of the Svelte persistentStore: a useState whose value is
 * mirrored to window.localStorage as JSON. Every access is inside a
 * try/catch because storage can throw (private mode, quota, ...), and the
 * initial value is the fallback when nothing is stored or it fails to parse.
 */
export function usePersistent<T>(key: string, initialValue: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    // Get initial value from localStorage or use default
    let storedValue = initialValue;
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem(key);
        if (saved !== null) {
          storedValue = JSON.parse(saved);
        }
      } catch (e) {
        console.error(`Error parsing stored value for ${key}`, e);
      }
    }
    return storedValue;
  });

  function set(next: T) {
    setValue(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch (e) {
        console.error(`Error saving value for ${key}`, e);
      }
    }
  }

  return [value, set];
}
