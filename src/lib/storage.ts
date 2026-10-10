import type { KeyValueStore } from "@/core/ports";

export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();
  get(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.data.set(key, value);
  }
  remove(key: string): void {
    this.data.delete(key);
  }
}

/**
 * localStorage-backed preferences. Storage can be unavailable (private mode,
 * blocked site data), so every access is guarded and failures are ignored.
 */
export class BrowserStorageStore implements KeyValueStore {
  constructor(private readonly prefix = "nova:") {}

  get(key: string): string | null {
    try {
      return window.localStorage.getItem(this.prefix + key);
    } catch {
      return null;
    }
  }
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(this.prefix + key, value);
    } catch {
      // preference persistence is best-effort
    }
  }
  remove(key: string): void {
    try {
      window.localStorage.removeItem(this.prefix + key);
    } catch {
      // ignore
    }
  }
}
