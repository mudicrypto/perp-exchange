let counter = 0;

/** Unique, human-readable client order id (used for idempotency by adapters). */
export function newClientOrderId(prefix = "nova"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
