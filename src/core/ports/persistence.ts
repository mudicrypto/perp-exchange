/**
 * Minimal key-value persistence for non-sensitive preferences
 * (selected market, chart interval). Never store secrets here.
 */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
