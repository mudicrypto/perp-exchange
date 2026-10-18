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

## 6. Milestone 10: comparison with Milestone 9 (A/B)

Milestone 10 adds work in three places:

- an idempotency-ledger record (canonical JSON of the command) per accepted new order
- the gateway normalises a message before the idempotency check, instead of hashing the raw message
- snapshots carry the ledger and its hash

To report a difference only under comparable conditions, both versions were run **alternately in
one session**, with the same seeds and parameters: the `27dee34` export, then the working tree,
three rounds, `venue:perf` at scale 0.5, one run each. Raw output and conditions:
`docs/venue/verification/m10-ab-benchmark.log`. Some read-only `git diff` and small documentation
edits ran during rounds 1–2.

| Scenario | M9 median ops/s (3 rounds) | M10 median ops/s (3 rounds) | Δ | Ranges overlap? |
|---|---|---|---|---|
| F1 matching only (code identical in both) | 130 070 (117 750–147 719) | 120 974 (119 428–131 981) | −7 % | yes |
| F2 matching + journal | 16 937 (15 161–18 423) | 16 053 (14 577–18 438) | −5 % | yes |
| F3 publication, immediate | 17 835 (17 352–19 212) | 15 650 (14 437–16 869) | −12 % | no |
| F3 publication, batched | 16 813 (15 412–19 875) | 17 180 (17 167–17 348) | +2 % | yes |
| F4 gateway mixed flow | 13 782 (12 618–14 225) | 14 990 (14 917–15 320) | +9 % | no |
| F5 bursty | 18 235 (15 973–18 583) | 17 278 (15 988–18 267) | −5 % | yes |
| F6 large book | 16 911 (13 991–18 218) | 16 557 (16 519–16 944) | −2 % | yes |
| F7 recovery, full replay | 21 352 (20 871–23 866) | 18 199 (16 215–18 790) | −15 % | no |
| F7 recovery, snapshot + suffix | 13 954 (13 597–16 343) | 11 758 (11 199–12 998) | −16 % | no |

**Reading:**

- **Noise floor.** F1 runs code that is identical in both versions, yet it moved −7 %. Differences
  of that size are noise.
- **Recovery is about 15 % slower, consistently.** The ranges do not overlap. This is consistent
  with recording a ledger entry (canonical JSON) for every accepted order during replay, and with
  hashing the ledger when a snapshot is restored.
- **The gateway path is about 9 % faster.** The ranges do not overlap. This is consistent with no
  longer serialising every incoming new-order message for an idempotency fingerprint.
- **Immediate publication (−12 %, no overlap) is not explained.** F2 uses the same submit path and
  stayed within noise, and batched publication did not move. Treat it as unresolved, not as a
  measured regression.
- **Scope.** Three rounds per side on a shared host are a small sample. These results show no gross
  regression and one plausible cost (recovery). They are not precise effect sizes.

The main tables in §2 and §4 still describe the Milestone 9 run. They were not re-run for
Milestone 10.

## 7. Milestone 10 review fixes: comparison (A/B)

The review fixes add a deep copy and freeze of every accepted order's events when the order is
recorded in the idempotency ledger (VR-25), and a copy for each replay.

**Method:** the unfixed Milestone 10 tree (a scratch copy) against the fixed tree, alternating in one
session with nothing else running. Three rounds per side, `venue:perf` scale 0.5. Raw output:
`docs/venue/verification/m10-review-fixes-ab-benchmark.log`.

| Scenario | Before fixes, median ops/s | After fixes, median ops/s | Δ | Ranges overlap? |
|---|---|---|---|---|
| F1 matching only (code identical in both) | 120 593 (104 873–129 744) | 136 889 (130 598–145 778) | +14 % | no |
| F2 matching + journal | 12 674 (12 538–16 185) | 13 782 (13 185–13 795) | +9 % | yes |
| F3 publication, immediate | 15 177 (15 093–15 582) | 13 482 (13 170–13 851) | −11 % | no |
| F3 publication, batched | 16 352 (16 031–16 963) | 13 616 (12 988–14 363) | −17 % | no |
| F4 gateway mixed flow | 14 905 (14 837–14 952) | 11 937 (11 858–11 976) | −20 % | no |
| F5 bursty | 15 702 (14 931–17 264) | 13 824 (13 622–14 390) | −12 % | no |
| F6 large book | 15 454 (13 855–15 706) | 13 419 (13 070–14 093) | −13 % | yes |
| F7 recovery, full replay | 16 028 (14 325–16 974) | 15 596 (13 783–16 166) | −3 % | yes |
| F7 recovery, snapshot + suffix | 11 311 (10 238–11 624) | 9 611 (9 501–10 308) | −15 % | yes |

**Reading:**

- **These runs are inconclusive. They establish neither a regression nor an improvement.**
- **The noise floor exceeds most of the differences.** F1 runs code identical in both versions,
  yet it moved +14 % with non-overlapping ranges. Non-overlapping ranges are therefore not evidence
  of a real change in this session, and differences of −11 % to −20 % (F3, F4, F5) are within the
  observed noise.
- **The order-entry results contradict each other.** F2 records the same ledger entries as F3–F5,
  yet it moved +9 %. No effect size for the per-order copy and freeze can be stated from these runs.
- **Recovery, measured separately:** full replay −3 % with overlapping ranges; snapshot + suffix
  −15 % with ranges that overlap only marginally. Neither shows a change beyond the noise floor. (The
  Milestone 9 comparison in §6 showed a more consistent recovery cost of about 15 %, against a
  smaller noise floor of 7 %; see there.)
- **What would settle it:** more rounds per side on an isolated or pinned host, with confidence
  intervals rather than ranges.
- **Not measured at all:** the final-review fix that deep-freezes every routed event and public
  message (VR-29). It adds a per-event freeze on every command; no A/B run was made for it.
- **A cheaper design is possible** if this matters later: freeze once without cloning, and give
  responses their own copies. It was not pursued, to keep the fix minimal and obviously correct.

## 8. Milestone 11: comparison with Milestone 10 (A/B) and memory

**What changed on the measured paths.**

- Every store-backed submit also writes the commit anchor (D-6). The benchmarks now give their store-backed
  venues an anchor, so they measure the same work plus the anchor.
- `submit` makes two cheap checks: it refuses operator records and quarantined commands.
- Routing updates the latest private sequence per account.
- The gateway checks an unfilled-FOK budget. The benchmarks raise it to 10⁹ like the other limits, so it never
  throttles them.
- The book and matching path are unchanged.

**Method.**

- `npm run venue:perf -- 1 1`, alternating `9812049` (baseline worktree) and Milestone 11, four runs each, on
  the same shared container.
- Raw logs: `verification/m11/perf-ab-against-9812049.log`.
- Throughput is reported as the median, with the range across runs in brackets.

| Scenario | Baseline ops/s | Milestone 11 ops/s | Median Δ | Ranges separate? |
|---|---|---|---|---|
| F1 matching, no persistence | 136,378 (114,876–140,822) | 151,612 (99,020–156,022) | +11.2 % | no |
| F2 matching + journal (memory store) | 14,724 (13,935–15,464) | 14,875 (12,722–15,383) | +1.0 % | no |
| F3 publication (immediate) | 15,068 (14,102–15,572) | 14,573 (14,235–15,539) | -3.3 % | no |
| F3 publication (batched) | 14,417 (14,116–15,657) | 14,672 (13,212–14,740) | +1.8 % | no |
| F4 gateway mixed entry/cancel/execution | 13,158 (12,551–14,396) | 12,604 (12,376–13,084) | -4.2 % | no |
| F5 bursty (queueing + service) | 14,302 (12,003–15,561) | 13,216 (12,254–14,083) | -7.6 % | no |
| F6 large book | 14,734 (14,315–15,330) | 12,630 (11,064–13,978) | -14.3 % | yes |
| F7 recovery (full replay) | 15,674 (13,034–17,316) | 15,504 (14,076–16,805) | -1.1 % | no |
| F7 recovery (snapshot + suffix) | 10,188 (9,422–10,970) | 9,383 (8,298–10,198) | -7.9 % | no |

**Reading.**

- **Noise floor.** F1 exercises engine code that did not change, yet it moved +11 % (one Milestone 11 run
  at 99 020 ops/s). Differences of a few percent are noise on this host.
- **F6 (large book) is the only scenario whose ranges separate: −14 %.** To isolate it, an F6-style script
  ran the same workload interleaved on both trees (`verification/m11/perf-f6-isolation.log`):
  - the baseline median was 9 274 ops/s;
  - Milestone 11 unanchored was 9 053 (−2 %), and anchored 8 832 (−5 %);
  - the ranges overlap.
- **The anchor itself** costs about **1.1 µs per command** (microbenchmark of building and writing the record),
  about 2 % of the ~47 µs store-backed path. This is consistent with F2's +1 %.
- **The in-suite F6 difference** is reproducible but not explained by the isolated measurements.
  - For context, §7 recorded a similar −13 % F6 difference with separated ranges for the Milestone 10 review
    fixes, which did not touch the book either.
  - It is recorded as an **open observation**, not attributed and not treated as a capacity statement.
- **Timing probe (VR-15).** It is unchanged in kind: the engine path still depends on hidden-only levels.
  That is expected, because the book is unchanged (D8, Milestone 12).

**Memory (VR-13).**

- Measured with `npm run venue:memory -- 50000 <config>`, one configuration per process, under `--expose-gc`.
- Raw log: `verification/m11/memory-probe.log`.
- The workload is 100 000 accepted orders, every one terminal.

| Configuration | Heap per accepted order |
|---|---|
| Defaults (audit caps disabled) | ≈ 2 825 B |
| All audit caps at 1 000 | ≈ 2 363 B (−16 %) |

- The in-memory copy of the journal is ≈ 314 B per entry, measured separately (≈ 13 %).
- The rest grows with every accepted order by design for the prototype (decision D7):
  - engine orders and the client-ID index;
  - the in-heap store text;
  - the idempotency ledger, up to its capacity.
