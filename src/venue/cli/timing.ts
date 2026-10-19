/**
 * `npm run venue:timing [rounds] [samples] [indexed|reference] [probe-prefix,…]` — Milestone 12 hidden-liquidity timing harness
 * (VR-15, VR-31). `reference` runs the same engine on the Milestone 11 sorted-array book.
 * Engine path, identical displayed liquidity, varying hidden-only levels. Local and indicative only
 * (docs/venue/PERFORMANCE-RESULTS.md §9).
 */
import { environment } from "../perf.ts";
import { formatTiming, timingHarness } from "../timing.ts";

const rounds = Number(process.argv[2] ?? 5);
const samples = Number(process.argv[3] ?? 2_000);
console.log(`Environment: ${environment()}`);
console.log(`Rounds ${rounds}, samples per round ${samples}; configurations alternate within each round.\n`);
const book = process.argv[4] ?? "indexed";
const engine = book === "reference" ? await import("../timing-reference.ts").then((m) => (c: ConstructorParameters<typeof m.ReferenceBookEngine>[0]) => new m.ReferenceBookEngine(c)) : undefined;
console.log(`Book: ${book}`);
console.log(formatTiming(timingHarness({ rounds: rounds > 0 ? rounds : 5, samples: samples > 0 ? samples : 2_000, ...(engine ? { engine } : {}), ...(process.argv[5] ? { probes: process.argv[5].split(",") } : {}) })));
