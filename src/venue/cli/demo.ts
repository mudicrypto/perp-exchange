/**
 * `npm run venue:demo` — runs the local venue prototype with synthetic
 * orders only. No network, no funds, no external execution.
 */
import { runDemo } from "../demo.ts";

const seed = Number(process.argv[2] ?? 7);
const messages = Number(process.argv[3] ?? 5_000);
const summary = runDemo(Number.isSafeInteger(seed) ? seed : 7, Number.isSafeInteger(messages) && messages > 0 ? messages : 5_000);
console.log(summary.lines.join("\n"));
const ok = summary.reconciliation.ok && summary.stateHash === summary.recoveredStateHash && summary.outputHead === summary.recoveredOutputHead;
process.exitCode = ok ? 0 : 1;
