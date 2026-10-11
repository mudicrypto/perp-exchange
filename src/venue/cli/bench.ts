/**
 * `npm run venue:bench [scale]` — indicative local micro-benchmarks of the
 * venue prototype (synthetic orders, in-memory, single process).
 */
import { formatBench, runBench } from "../bench.ts";

const scale = Number(process.argv[2] ?? 1);
console.log(`Nova venue prototype — local micro-benchmarks (node ${process.version}, ${process.arch}); indicative only.`);
console.log(formatBench(runBench(Number.isFinite(scale) && scale > 0 ? scale : 1)));
