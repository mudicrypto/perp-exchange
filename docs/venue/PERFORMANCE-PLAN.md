# Nova Venue — Performance Test Plan

Status: Milestone 8. This is a **plan**, plus an **indicative baseline** of the local prototype. It
does not establish production performance targets, and no production performance is claimed.

## 1. Objectives

1. Measure throughput and latency of order entry, matching and publication under realistic and
   adversarial order flow.
2. Find the worst-case paths, especially those that hidden orders can trigger, and bound them:
   - deep books
   - long sweeps
   - many hidden orders at one level
   - STP-heavy flow
   - mass cancels
3. Measure how long recovery takes: journal replay rate, and snapshot and restore time.
4. Detect regressions in continuous integration.
5. Check that performance does not become a side channel (THREAT-MODEL T-H7). Latency distributions
   must not depend measurably on hidden-book state.

## 2. Metrics

| Metric | Definition |
|---|---|
| Throughput | Sequenced commands per second at saturation; per scenario |
| Latency | Gateway receipt → private acknowledgement; sequencing → public publication. Report p50, p99, p99.9 and max, never only means. |
| Publication delay | Command sequenced → public message emitted (immediate and batched modes) |
| Replay rate | Journal entries per second during recovery |
| Snapshot cost | Snapshot creation time and size; restore time |
| Memory | Bytes per resting order; growth over long runs (terminal-order retention) |
| Fairness | Latency difference between hidden-heavy and displayed-only books for the same visible flow (side-channel check) |

## 3. Scenarios

| ID | Scenario | Purpose |
|---|---|---|
| S1 | Mixed synthetic flow (`syntheticFlow`): adds, cancels, replaces, IOC/FOK/market, post-only, about 25 % hidden | Baseline |
| S2 | Resting adds growing the book to N levels × M orders | Level insertion cost, memory |
| S3 | IOC sweeps across K levels, displayed and hidden mixed | Matching inner loop |
| S4 | Add/cancel churn at the touch (market-maker load) | Queue removal cost |
| S5 | One level with 10⁴ hidden orders behind displayed ones; small takers | Hidden-queue walking; side-channel measurement |
| S6 | STP-heavy flow (`cancel-maker` against many own orders) | STP cost |
| S7 | Mass cancel of accounts with `maxOpenOrders` resting orders | Burst cost |
| S8 | Batched publication with large intervals | Netting cost; batch size |
| S9 | Recovery: replay of 10⁶ to 10⁸ journal entries; snapshot at intervals | Recovery time objective |
| S10 | Adversarial: gateway floods at and above limits; malformed inputs | Cost of refusals; isolation of honest accounts |
| S11 | Soak: 24 h mixed flow | Memory growth, latency drift |

Every scenario runs with fixed seeds and records the seed, the code revision and the runtime
version. Each result must be reproducible.

## 4. Method

- **Environment:**
  - dedicated hosts; pinned CPU frequency; isolated cores for the engine thread
  - pinned runtime version
  - warm-up before measurement
  - at least 5 runs per scenario
  - report the spread between runs
- **Instrumentation:** monotonic high-resolution timers at the gateway, the sequencer, the engine
  start and end, and publication. Use HDR histograms, not averages.
- **Load generation:** separate processes or hosts, open-loop (fixed arrival rate). This avoids
  coordinated omission. Closed-loop tests are only for maximum throughput.
- **Correctness under load:** run `reconcile()` after every scenario, and compare state and output
  hashes with a replay. A fast wrong answer fails the test.
- **Side-channel check (S5):** run identical visible flow against books with and without a large
  hidden queue. Compare acknowledgement-latency distributions, for example with a two-sample
  Kolmogorov–Smirnov test. A detectable difference is a finding for THREAT-MODEL T-H7.
- **CI regression guard:** a reduced S1/S3/S4 run on every change. Fail on a >20 % regression of
  p99 against the stored baseline, measured on the same runner class.

## 5. Acceptance criteria (to be set before any production design review)

Targets are deliberately **not** set by this milestone. Production targets must come from:

- expected message rates
- the latency needed for fair cancel behaviour
- recovery-time objectives
- hardware chosen for the production engine

The production engine is not expected to be this TypeScript prototype.

## 6. Prototype baseline (indicative only)

`npm run venue:bench` runs S1–S4 and S9 in one process, using an in-memory journal and no I/O.
Measured in the build container (Node v22.22.0, x64, shared CPU) at commit time:

| Scenario | Ops | Ops/s | p50 µs | p99 µs | p99.9 µs | Max µs |
|---|---|---|---|---|---|---|
| B1 gateway: mixed flow (S1) | 50 000 | ~14 000 | 46 | 255 | 2 179 | 15 030 |
| B2 engine: resting adds, deep book (S2) | 40 000 | ~25 000 | 30 | 97 | 1 998 | 4 629 |
| B3 engine: IOC takers vs deep book (S3) | 2 000 | ~13 600 | 32 | 289 | 3 571 | 20 326 |
| B4 engine: add/cancel churn (S4) | 40 000 | ~48 500 | 19 | 65 | 256 | 3 014 |
| B5 recovery: replay 50 010 entries (S9) | 50 010 | ~18 600 | — | — | — | — |

How to read these numbers:

- They come from one shared, unpinned machine with garbage-collection pauses, which explains the
  long tails.
- They are not comparable to any production system.
- The likely dominant costs are per-command SHA-256 and canonical JSON for the journal and output
  chains, plus Zod validation of every command. These have not been profiled in detail.
- A production engine would move hashing and validation off the matching thread and use preallocated
  data structures.

S5–S8, S10 and S11, the side-channel check, and HDR/open-loop measurement are **not yet
implemented**.
