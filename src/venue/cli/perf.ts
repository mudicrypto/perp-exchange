/**
 * `npm run venue:perf [scale] [runs]` — Milestone 9 reproducible synthetic
 * benchmarks and timing probe. Local, in-memory, single process; indicative
 * only (docs/venue/PERFORMANCE-RESULTS.md).
 */
import { environment, formatPerf, runPerf, timingProbe } from "../perf.ts";

const scale = Number(process.argv[2] ?? 1);
const runs = Number(process.argv[3] ?? 3);
console.log(`Environment: ${environment()}`);
console.log(`Parameters: scale ${scale}, runs ${runs}, seeds 1001.. (engine flow) / 2001.. (gateway flow)\n`);
console.log(formatPerf(runPerf({ scale: scale > 0 ? scale : 1, runs: Number.isSafeInteger(runs) && runs > 0 ? runs : 3 })));
for (const via of ["engine", "gateway"] as const) {
  console.log(`\nTiming probe (${via} path) — median µs of a displayed add at a new level in front of N hidden-only levels, per round:`);
  for (const row of timingProbe(5, 4_000, via)) console.log(`  hidden-only levels ${String(row.hiddenLevels).padStart(6)}: ${row.medianUs.map((v) => v.toFixed(1)).join(", ")}`);
}
