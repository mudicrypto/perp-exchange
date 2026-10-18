/**
 * `npm run venue:memory [pairs] [config]` — Milestone 11 VR-13 memory probe (retained heap per accepted order).
 * Run one configuration (0: defaults, 1: audit caps) per process for clean readings.
 * Local, in-memory, single process; indicative only (docs/venue/PERFORMANCE-RESULTS.md §8).
 */
import { environment, memoryProbe } from "../perf.ts";

const pairs = Number(process.argv[2] ?? 50_000);
console.log(`Environment: ${environment()}`);
if (!(globalThis as { gc?: unknown }).gc) console.log("warning: run with node --expose-gc for stable readings");
const only = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
for (const r of memoryProbe(Number.isSafeInteger(pairs) && pairs > 0 ? pairs : 50_000, only)) {
  console.log(
    `${r.config.padEnd(32)} accepted orders ${r.acceptedOrders}: heap ${r.heapBytesPerAcceptedOrder.toFixed(0)} B/order ` +
      `(of which the in-memory journal store text ≤ ${r.journalStoreBytesPerAcceptedOrder.toFixed(0)} B); retained ${JSON.stringify(r.retained)}`,
  );
}
