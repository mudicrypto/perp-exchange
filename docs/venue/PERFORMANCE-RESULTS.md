# Nova Venue — Performance Results (Milestone 9)

These are **local, synthetic measurements of a single-process TypeScript prototype with an in-memory
store.** They are not capacity figures and must not be read as such. No targets are set or implied.
The measurement plan is in [PERFORMANCE-PLAN.md](PERFORMANCE-PLAN.md).

## 1. How to reproduce

```bash
npm run venue:perf -- 1 3      # scale 1 (60 000 commands per scenario), 3 runs
```

- Source: `src/venue/perf.ts`
- Raw output of the run reported here: `docs/venue/verification/perf-run.log`

| Item | Value |
|---|---|
| Environment | Node v22.22.0; Linux 6.18.44 x64; 4 × Intel Xeon @ 2.10 GHz (shared cloud container, frequency not pinned); 16 GiB RAM |
| Seeds | Engine flow 1001, 1002, 1003 (one per run); gateway flow 2001, 2002, 2003 |
| Flow mix (engine) | 55 % new orders (¼ hidden, GTC; displayed: GTC/IOC/FOK), 30 % cancels, 15 % replaces; 41 price ticks around the reference; 16 accounts; STP `cancel-maker` |
| Flow mix (gateway) | `syntheticFlow`: adds, cancels, replaces, IOC/FOK/market, post-only, mass cancel |
| Timing | `process.hrtime` around each call; percentiles are nearest-rank over all operations of the run |
| Limits | Raised (10⁹ messages per second) so rate limiting does not dominate |

## 2. Results

The evidence run is in `perf-run.log`: 3 runs on the final code, with nothing else running. The
table shows its median, with the throughput range across its 3 runs in brackets. The last column
gives the median throughput of an **earlier** run in the same container on 2026-10-11, before the
review follow-up. It is kept to show how much this shared host varies: F1 does not touch any code
that changed between the two runs, yet its throughput differs by about 35 %. **Differences of that
size between runs say nothing about the code.**

| Scenario | Parameters | Ops/s | p50 µs | p95 µs | p99 µs | Earlier run, ops/s |
|---|---|---|---|---|---|---|
| F1 matching only (no journal, no routing, no validation) | 60 000 mixed commands | 126 223 (121 705–167 777) | 3.3 | 21.3 | 37.6 | 192 442 |
| F2 matching + journal (schema check, hash chain, canonical JSON, memory-store append, routing) | 60 000 mixed; store 20.6 MiB | 16 901 (16 811–19 948) | 37.5 | 142.4 | 232.5 | 21 662 |
| F3 publication, immediate (F2 + validating public mirror + private-event polling) | 60 000; ≈ 39 900 public messages | 16 358 (14 642–18 280) | 37.0 | 145.8 | 242.7 | 19 130 |
| F3 publication, batched (publish every 50 commands) | 60 000; ≈ 28 100 public messages | 18 906 (16 690–18 915) | 33.5 | 124.9 | 215.5 | 18 448 |
| F4 gateway: mixed entry, cancellation and execution (session, Zod, decimal conversion, idempotency) | 60 000 messages | 14 622 (14 486–17 130) | 43.0 | 133.8 | 201.1 | 16 558 |
| F5 bursty, open loop: bursts of 2 000 every 200 ms; latency = queueing + service | 60 000 | 17 522 (17 346–19 484) | 53 731 | 109 948 | 127 171 | 19 449 |
| F6 large book: 100 000 resting orders (25 % hidden) on 300 levels per side, then mixed flow | 60 000 | 19 396 (15 157–19 559) | 35.8 | 121.0 | 197.7 | 19 235 |
| F7 recovery, full replay | 60 018 journal entries | 17 038 (15 136–21 747) entries/s | 58.7 (mean per entry) | — | — | 23 055 |
| F7 recovery, snapshot (4.3 MiB) + suffix | 29 999 entries | 13 644 (13 391–15 903) entries/s | 73.3 (mean per entry) | — | — | 15 937 |

Maximum latencies ranged from about 4.7 ms to 169 ms across scenarios and runs (raw log). These
outliers are consistent with garbage-collection pauses and the shared host. They are not explained
by the workload.

## 3. Reading the numbers

- **Persistence and validation dominate.** Matching alone (F1) is about 7.5× (evidence run) to
  9× (earlier run) faster than F2. The
  difference is per-command work:
  - SHA-256 of canonical JSON for the journal chain
  - a second SHA-256 for the output chain
  - Zod validation of each command
  - routing

  This is measured, but has not been profiled down to individual functions. The store here is a
  string append. A real store adds I/O and fsync cost, which is **not measured**.
- **Batched publication** reduces public messages by about 30 % (netting). It does not reduce
  latency here, because the mirror and publication are not the bottleneck.
- **F5 shows queueing, not a fault.** A burst of 2 000 commands at about 19 000 per second takes
  about 100 ms to drain, so the median command waits about 50 ms. Any burst larger than the service
  rate × gap queues; nothing is shed or prioritised (cancels wait behind new orders). That ordering
  matters for fair cancel behaviour and is a design input, not a result to optimise here.
- **F6:** a 100 000-order book far from the touch does not slow down activity near the touch. The
  sorted-array cost appears only when new levels are inserted in front of many levels (§4).
- **F7:** recovery replays at about the same rate as live processing, because it is the same code
  path. "Snapshot + suffix" includes restore and state-hash verification (4.3 MiB), which costs more
  per entry when spread over half as many entries. Per-entry latency is a mean, not a distribution.

## 4. Timing side-channel probe (PRIVACY-REVIEW T-H7, VR-15)

The probe measures the median latency of adding a displayed order at a new price level placed *in
front of* N hidden-only levels. It runs 4 000 adds per round, over 5 rounds, with a fresh venue for
each configuration. Two runs are reported.

| Hidden-only levels | Engine path, evidence run (µs) | Gateway path, evidence run (µs) | Gateway path, earlier run (µs) |
|---|---|---|---|
| 0 | 4.9, 2.9, 3.0, 3.0, 2.9 | 204.8, 174.3, 189.7, 158.5, 162.4 | 171.0, 154.4, 144.2, 150.2, 180.0 |
| 1 000 | 3.2, 3.3, 3.0, 2.9, 3.2 | 188.5, 190.7, 228.9, 157.6, 182.7 | 161.6, 176.6, 169.1, 152.5, 191.9 |
| 50 000 | 11.2, 11.0, 10.7, 10.3, 11.2 | 216.7, 245.5, 227.9, 207.3, 242.4 | 161.7, 188.2, 174.2, 184.9, 192.6 |

- **Engine path:** a clear, repeatable dependence on the number of hidden-only levels, about 3.5×
  at 50 000 levels, in both runs. The cause is `Array.splice` in `BookSide.add`.
- **Gateway path:** the two runs disagree.
  - Earlier run: the round medians overlapped (means 160 against 180 µs).
  - Evidence run: they **separated**. Every 50 000-level round (207–245 µs) was slower than every
    0-level round (158–205 µs); the means are 178 against 228 µs.

  **The channel should be treated as plausibly observable end to end through the in-process
  gateway.** It is not established as reliably exploitable, and it is not ruled out. Network
  jitter would add noise in a deployment. A co-located attacker with many samples is the relevant
  threat.
- **Mitigations** (not implemented):
  - a price-level structure indexed by tick offset (constant-time insert)
  - acknowledgement batching or fixed-latency acknowledgements

## 5. Limitations

- One shared, unpinned 4-core container. There is no CPU isolation and no repetition across
  machines.
- Closed-loop measurement, except F5. The load generator and the system share one thread, so there
  is no network, serialisation or kernel cost.
- In-memory store: no durability cost.
- Synthetic flow over a narrow price range. Real flow distributions are unknown.
- Nearest-rank percentiles over single runs, with the median of 3 reported. No HDR histogram, no
  confidence intervals.
- Not measured: S5–S8, S10 and S11 from the plan, apart from what F3, F5 and F6 cover.
