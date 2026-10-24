# Venue × Stellar — Testnet Feasibility Spike: Results and B1 Recommendation (Milestone 12, WP3)

**Status:** results for review. The spike was a bounded, testnet-only run of a **measurement contract**.
No vault was built. No tokens, deposits or withdrawals were involved, and nothing was deployed outside
testnet. The application, the venue engine (`src/venue/engine.ts`) and the execution mode are unchanged.

- Design under test: [`STELLAR-FEASIBILITY.md`](STELLAR-FEASIBILITY.md)
- Code and reproduction steps: [`spikes/stellar-settlement/`](../../spikes/stellar-settlement/README.md)
- Raw results: `docs/venue/verification/m12/stellar-spike/` (two runs, every transaction listed)

**How to read the numbers.** Each value carries one of three labels.

- **[chain]**: measured from a transaction included in a testnet ledger (fee charged, ledger, outcome).
- **[sim]**: reported by RPC simulation (`simulateTransaction`). This covers CPU instructions, footprints
  and resource fees, and is also how the network prices the transaction.
- **[estimate]**: derived by arithmetic from measured values and the network configuration. Not observed.

Fees are in stroops (10⁷ stroops = 1 XLM). They are **testnet** fees and have no monetary value.

## 1. Summary

| Question | Answer |
|---|---|
| Does a per-fill settlement fit in a transaction? | **Yes, comfortably.** About 2.7 M instructions (0.7% of the transaction limit) and 7 written entries (3.5%) [sim] |
| Batch capacity | **33 fills** per transaction (strict cursor) or **28** (idempotent identifier) with distinct accounts. Both are bound by the **200 written entries** per transaction [sim]. Both maximums were submitted successfully [chain] |
| Fee per fill | **282,958** stroops with persistent fill counters, **39,321** with temporary counters. About 94% and 54% of each is storage rent [chain] |
| Does batching save fees? | **Barely.** 280,727 stroops per fill at k = 33 versus 282,958 single (persistent) [chain], because rent dominates |
| Settlement latency | Median **4.2 s** from submission to an observed result; 1 ledger (at most 2); ledgers close every 5 s [chain] |
| Signature verification | About **436,000 instructions** per ed25519 verification; at most about **915** fit in one transaction [sim] |
| Journal anchoring | **3,665** stroops per anchor in steady state [chain] |
| Storage TTL | Temporary and persistent entries both reach **3,110,399 ledgers** (about 180 days). Persistent entries can never be given less than **120,960 ledgers** (about 7 days). Extending past the maximum is an error, not clamped [chain] |
| Duplicates, retries, gaps | Rejected exactly as designed, on chain and in simulation (§4) |
| **Strict cursor under concurrent submission** | **12 of 30 fills failed** across two runs. Each failure left a **permanent gap**: a fill that can never settle [chain] |
| **Idempotent fill identifier, same test** | **30 of 30 succeeded**. A concurrent duplicate was rejected on chain [chain] |
| Epoch invalidation, cross-contract replay | Rejected (`StaleEpoch`; signature verification failure) [sim, after a chain epoch bump] |

**Recommendation (§9): conditional GO.** Proceed to a B1 vault **design proposal**, not an
implementation, with these changes to the design:

1. Replace the strict settlement cursor with idempotent fill identifiers.
2. Decide how hidden orders are treated, because settlement publishes signed order terms.
3. Measure archival restoration and token-transfer cost before any vault code.

The strict-cursor design **as specified** is a **no-go**: under any concurrency it converts ordinary
transaction reordering into settlement breaks.

## 2. Environment and runs

| Item | Value |
|---|---|
| Network | Stellar testnet: passphrase `Test SDF Network ; September 2015`, protocol 29 |
| RPC | `https://soroban-testnet.stellar.org`, stellar-rpc 30.0.0, stellar-core 30.0.0 |
| Contract | `spikes/stellar-settlement/contract`, `soroban-sdk` 29.0.1, built with `stellar contract build` (stellar-cli 28.1.0, Rust 1.97.0, `wasm32v1-none`) |
| Wasm | 12,421 bytes, sha256 `9a4bebc55ddbc1ba517c66a019a4903cb02b164c696b5b7de762372a76f321e3` (also the on-chain wasm hash) |
| Client | `spikes/stellar-settlement/client/spike.mjs`, `@stellar/stellar-sdk` 17.2.1, Node 22 |
| Native tests | `cargo test`: 9 passed |

Two complete runs. The second run is the reference; the first is a replication, made before the last
instrumentation changes (§8).

| Run | Time (UTC) | Transactions | Contract A (persistent counters) | Contract B (temporary counters) | Contract C (replay target) |
|---|---|---|---|---|---|
| Reference | 2026-10-24 10:12:52–10:24:41 | 86 | `CBAIXBJII3CXEJJCKROYWUYQIVMY7EXKNUTZPJ2OB2PBTPV4MMRLKREE` | `CCTWGMZZT7PGT3OO5N6EQ7QOKALRLC5UVTKAH2FFRP6CFBH66RI4V672` | `CADXJHOPWYHNVVT5GSFG372UDPA7PZABQLF5KEKPJMFF63M73Y4HLKXC` |
| Replication | 2026-10-24 09:59:42–10:11:14 | 83 | `CD5HCIESTCEWKDJ72FNM5TAWQABNN6WBQZWDNL7VRQHC7C3RFYA7SLWN` | `CA5C3JFJQFZVDJE3YUEDCVXMEWPEKN6GE6WZT7AZ7BQ4OQHYFAMLRQOZ` | `CDCSIOYAN3VWVXEYUA4I6PLREECNHUHDDP2CXPRN6DMMNXTSAPB4ZSDA` |

**Accounts.** Reference-run operator `GBVJNYM55QS5DNSKZJBMPJK6MSASTXYJEDBTU5DPEY4B6RA565KOKQ22`, plus five
channel accounts (listed in the summary file). All were funded by friendbot, and the funding was verified
on chain (10,000 XLM each, testnet) before use. Keys existed only in memory for the run. Trader accounts
are random addresses with registered ed25519 trading keys; they hold no lumens.

**Transaction lists:**

- `transactions-2026-10-24T10-12-52-415Z.md` (reference run)
- `transactions-2026-10-24T09-59-42-468Z.md` (replication run)

These give every hash, ledger, in-ledger application order, fee and contract error code.

**The order-hash encoding matches** the contract's (`sha256("venue-order/1" ‖ network id ‖ contract
address XDR ‖ order XDR)`): the client-side hash equals `order_hash` [sim].

**Network configuration read from the ledger** (per transaction unless noted):

| Limit | Value |
|---|---|
| Instructions | 400,000,000; ledger 580,000,000 |
| Written entries | 200; ledger 2,000 |
| Footprint entries | 400 |
| Write bytes | 132,096; ledger 297,000 |
| Transaction size | 132,096 bytes; ledger 864,000 |
| Contract events | 16,384 bytes |
| Transactions per ledger | 2,000 |
| Dependent transaction clusters per ledger | 3 |
| Memory | 41,943,040 bytes |
| State archival | `maxEntryTtl` 3,110,400; `minPersistentTtl` 120,960; `minTemporaryTtl` 720 |

**Inclusion fee:** 100 stroops at p10–p95 over the last 50 ledgers, 200 at p99.

**Ledger close:** 5 s for every one of 2 × 200 sampled ledgers. The RPC reports whole seconds, so
sub-second variation is invisible.

## 3. Measurements

### 3.1 Signature verification [sim]

`verify_n(key, msg, sig, n)` verifies the same ed25519 signature *n* times.

| n | 0 | 1 | 2 | 4 | 8 | 16 | 32 | 64 |
|---|---|---|---|---|---|---|---|---|
| Instructions | 571,443 | 991,289 | 1,415,580 | 2,288,860 | 4,035,419 | 7,528,538 | 14,514,775 | 28,487,250 |

- **Marginal cost: 436,184 instructions per verification** (loop overhead included).
- The computed maximum, **n = 915**, simulated successfully at 400,067,754 instructions (the limit is
  enforced with a small margin). n = 961 failed with `Error(Budget, ExceededLimit)`.
- A fill verifies two signatures, which is about **0.87 M of its 2.7 M instructions (32%)**.
  Signatures are not the bottleneck: write entries are (§3.3).

### 3.2 Per-fill settlement [chain]

Reference run. Each row is one transaction settling one fill: maker sells, taker buys, at the maker's
price, with two fresh signed orders.

| Variant | Example transaction | Fee (stroops) | Of which rent | Instructions [sim] | Read-only / read-write entries | Write bytes | Envelope bytes |
|---|---|---|---|---|---|---|---|
| Cursor, persistent counters (A) | `97db6c48cf4dac2fb1fe16176674bf67fe38e0a8366aff7cbe27dd71ba0ecef6` | **282,958** | 265,029 | 2,694,466 | 5 / 7 | 1,176 | 3,152 |
| Cursor, temporary counters (B) | `183cfcaba558b736d33d719726cb3bf74705bf582d5bbf0553056b6ceb631136` | **39,325** | 21,395 | 2,697,242 | 5 / 7 | 1,176 | 3,152 |
| Idempotent identifier, persistent (A) | `eefe0012c367622e0740ab8bcdfb6b906648e82065bb31f9ada68809d9dfc6be` | **392,475** | 374,384 | 2,740,183 | 6 / 7 | 1,008 | 3,252 |
| Idempotent identifier, temporary (B) | `b27d6a809b7d64bcf4fa333a8c1de4fe806fc1aa4f4a9fb708fc37abef1c2fbc` | **48,508** | 30,415 | 2,747,170 | 6 / 7 | 1,008 | 3,252 |

**Spread.** Over five fills per variant (three for the idempotent variants), fees varied by under 10
stroops after the first fill on each contract. The replication run matches within 0.1%.

**First fill on each contract.** It cost **1,771,846** stroops on A and **1,528,214** on B. The likely
cause (inferred): the first cursor write enlarges the contract's instance entry, which lives for the
maximum TTL, so rent for the added bytes is charged for about 180 days. The first anchor shows the same
effect (§3.5).

**What the entries are.**

- Read-only: the wasm code, two trading keys, two epochs; the idempotent variant also reads the instance.
- Read-write:
  - cursor variant: the instance (cursor), two fill counters, four balances;
  - idempotent variant: two fill counters, the settled marker, four balances. The instance becomes
    read-only.

**Why temporary storage is about 7× cheaper.** A persistent entry must be paid for at least 120,960
ledgers (about 7 days) whatever its intended life. The fill counter on A received exactly that:
`liveUntil` − `lastModified` = 120,959 ledgers. A temporary counter can be paid only until order expiry:
on B, `liveUntil` = expiry + 100 margin ledgers.

### 3.3 Batch capacity [sim] and batched submission [chain]

**Sweep (simulation).** Batches with every fill on fresh orders. "Distinct" means every fill involves
two different accounts, which is the realistic worst case. "Shared" means all fills are between the same
two accounts, the best case. The transaction size check uses the **assembled** envelope, footprint and
authorisation entry included.

| Case | Max k | Limit reached at k + 1 | Read-write entries at max | Instructions at max | Envelope bytes at max |
|---|---|---|---|---|---|
| Cursor, distinct accounts (A and B) | **33** | written entries (205 > 200) | 199 | 144.9 M | 90,920 |
| Idempotent, distinct accounts (A and B) | **28** | written entries (203 > 200) | 196 | 127.7 M | 79,792 |
| Cursor, shared accounts (A and B) | 73 | transaction size | 151 | 155.9 M | 130,984 |

In the reference run the RPC refused to simulate k = 34 on A ("request exceeded processing limit
threshold"). In the replication run k = 34 simulated and was over the written-entry limit.

**Submitted batches (reference run, contract A unless noted):**

| k | Shape | Transaction | Result | Fee (stroops) | Fee per fill | Instructions [sim] | Envelope bytes |
|---|---|---|---|---|---|---|---|
| 2 | distinct | `8de227b0bbc924267a4c5c5abad0cd3165901e3e904462c05e2f3f81a2089c07` | SUCCESS | 563,166 | 281,583 | 4,984,034 | 5,928 |
| 16 | distinct | `08ada4018097cc6fd87e6e117a7438d7e439353ee2349f132eb20c77a2523a0c` | SUCCESS | 4,487,731 | 280,483 | 52,057,669 | 44,344 |
| **33** | distinct | `2435910d85be762745a3cd66d46fefc60c9762e4764dc1dd3eb54f381a35d440` | SUCCESS | 9,264,005 | **280,727** | 144,988,738 | 90,992 |
| **33** (B, temporary) | distinct | `c649a2a4c6963d4697b914a2b87d21310e087d85e820ac79180290f88028d54e` | SUCCESS | 1,218,304 | **36,918** | 147,724,183 | 90,992 |
| **28** (idempotent) | distinct | `35cc9035aeae73cac7111f63d2ceab7846e952ca1bf2c71fae2dc73dac2562aa` | SUCCESS | 10,966,264 | **391,652** | 127,621,052 | 79,864 |
| 73 | shared | `c0d65b911e67c3e2b711e2f2ec5277bb7a50a9489b9c4e1ad581e856214c9498` | **RPC refused** (`invalid_xdr`) | — | — | 156,141,429 | 131,056 |
| 58 | shared | `a3b208c767021248d1ec0aaea80005453bc8170ea43c0f1e11990cadd0ea91ac` | **RPC refused** (`invalid_xdr`) | — | — | 120,464,595 | 104,416 |
| 46 | shared | `f7c35aeaaec1e96b76c4b0cea04f676b1c214241467d61b752238cc7f34ed8eb` | SUCCESS | 12,547,654 | 272,775 | 93,165,426 | 83,104 |

**Findings.**

- **Useful k is reached.** The design's go criterion of about 10 or more is met with the realistic
  shape: k = 33 (cursor) or 28 (idempotent). The binding limit is **200 written entries per
  transaction**, not signatures or CPU.
- **Batching does not reduce the fee per fill materially.** It falls by 0.8% (persistent) or 6%
  (temporary). Rent is charged per entry, so a batch pays the same rent as its fills would separately;
  only the inclusion fee and part of the non-refundable fee are shared.
- **CPU per fill rises with batch size.** It goes from 2.49 M (k = 2) to 3.25 M (k = 16) to 4.39 M
  (k = 33) instructions [sim], against 2.69 M for a single fill. The cause was not investigated (§8).
- **The public RPC refused envelopes of 104,416 bytes and more**, even though the protocol limit is
  132,096 bytes and simulation accepted them; it accepted 90,992 bytes. The refusal is the RPC's own
  limit, not the network's (inferred: the transaction never reached the network). Through this endpoint
  the practical limit is therefore between 90,992 and 104,416 bytes. The k = 33 distinct batch, at
  90,992 bytes, is close to it.
- **Assembled envelopes are about 3.5× the bare invocation** (90,992 bytes against 25,780 for k = 33).
  The footprint lists every entry key, and the authorisation entry repeats the invocation arguments.

### 3.4 Settlement latency [chain]

| Measure | Value (reference run, 74 included transactions) |
|---|---|
| Submission → result observed | min 1,822 ms, **median 4,223 ms**, max 7,296 ms (polling every 250 ms) |
| Ledgers waited after submission | median **1**, max 2 |
| Simulation and assembly before submission | median 920 ms, max 12,295 ms (RPC-dependent) |
| Ledger close interval | 5 s (all 400 sampled) |
| Three fills settled one after another (send, wait, send) | 14,614 ms; consecutive ledgers 5362773, 5362774, 5362775 |

**One source account can have only one transaction pending.** A second settlement from the operator,
with the next sequence number, was sent after the first had been accepted (`PENDING`) but before it was
included. It was **refused with `txBAD_SEQ` (-5)**. The reference-run transactions are
`ce56f265…b28d` (included, ledger 5362756) and `46175997…f317` (refused). The replication run showed
the same result. Pipelining from one account is therefore not possible: more than one settlement
transaction per ledger requires **several source accounts** (channel accounts), and §4.4 shows what that
does to a strict cursor.

### 3.5 Journal anchoring [chain]

| Anchor | Transaction | Fee (stroops) | Rent | Instructions [sim] |
|---|---|---|---|---|
| First | `7ef5863329fc59de98d9a8d541b65742576cda130c16b1f841843e2826adea1c` | 2,883,557 | 2,879,899 | 685,599 |
| Later | `69465c469c7a09223a78951ded18e932d23d84fdc7a7bd8bf8934adbb6d8021d` | **3,665** | 0 | 707,066 |
| Later | `db15875950263a3990f06ebef5e22db93ff4f9077870a31e7fd614569d8f68b6` | **3,665** | 0 | 707,066 |

- An anchor overwrites a fixed-size head (32 bytes) and a counter in instance storage. After the first,
  it adds no bytes and therefore no rent.
- **Fixed-cadence anchoring is cheap** [estimate]: one anchor per minute (every 12 ledgers) costs about
  5.3 M stroops (0.53 XLM) per day at these fees.
- The first anchor's cost is the one-time instance growth described in §3.2. The lesson for a vault:
  keep instance storage small and fixed in size.

### 3.6 Storage TTL [chain, read back with `getLedgerEntries`]

| Probe | Transaction | Fee (stroops) | Requested | Resulting live-until − ledger |
|---|---|---|---|---|
| Temporary entry, extend to the maximum | `e01478676573ce7a6b1a581c4436a42f302350d9806fb9cbd5007de8a811b9dc` | 1,245,831 | `max_ttl()` = 3,110,399 | **3,110,399** (about 180 days) |
| Persistent entry, extend to the maximum | `8905e722b4370c169bc59ed834840a0f9d5497602feb319be6290476cd68f9f2` | 2,488,456 | 3,110,399 | **3,110,399** |
| Persistent entry, extend to 1 ledger | `99e1170648d3612b9fe04c947c0f74000574560dc654764434095caec5263328` | 101,055 | 1 | **120,959**: the minimum persistent TTL applies |
| Extend past the maximum (3,110,400) | — | — | — | **Rejected:** `Error(Storage, InvalidAction)` [sim]. Not clamped |
| Fill counter on A (persistent) | from `c842caa1…` | — | order expiry + 100, about 17,380 | 120,959 |
| Fill counter on B (temporary) | from `e9cbff03…` | — | order expiry + 100 | **expiry + 100**, exactly |
| Contract instance (extended at `init`) | — | — | maximum | live until ledger 8,473,049 |

**Rent rates.** Rent for the same entry and the same 180 days was 1,245,831 stroops (temporary) against
2,488,456 (persistent), which matches the configured rent-rate denominators (2430 and 1215).

**Not observed:**

- **archival and restoration**: no entry reached the end of its TTL during the spike; the shortest
  persistent TTL is about 7 days;
- **expiry of a temporary entry**.

These are open items (§8, §9).

### 3.7 Cost of the remaining operations [chain]

| Operation | Transaction | Fee (stroops) |
|---|---|---|
| Upload wasm | `299248967676bf34c3c116aecf7c256951d5ae4f8aea58d6ad631021277e5ca0` | 32,013 |
| Create a contract instance | `c812511d5bd5120f9a6efcf1c35381cd0ef7c230dba1818482aefc956c98e833` | 105,198 |
| `init` (instance extended to the maximum TTL) | `4f4f5b3e86117816aa2d9b0e76d18e1b08f93805bec605df09d152990ea80394` | 5,491,932 |
| Register a key and seed two balances, per account (40 per transaction) | `0286a7338a58c4320fd541e33f94349cc863ebf084846849ed2dfd9eda79be27` | 476,021 per account |
| Epoch bump (one persistent entry) | `0d34a07d00c1946be29a228daf6d9a91c81ddee5b2f5f021a43f8f553edbe4f8` | 135,971 |
| A transaction that **fails on chain** (contract error) | 7 cases in the reference run | 20,664–20,786 |

A failed settlement still pays about 20,700 stroops (the non-refundable part plus inclusion). This is
the cost of every unnecessary failure in §4.4.

## 4. Exactly-once settlement: strict cursor versus idempotent fill identifier

### 4.1 The two rules (both in the measurement contract; every other check is identical)

- **Strict cursor** (`settle`, `settle_batch`). One instance value `(seq, idx)`. A fill must be
  strictly greater than it, and settling the fill sets the cursor to it.
- **Idempotent fill identifier** (`settle_idem`, `settle_batch_idem`). One entry `Settled(seq, idx)` per
  fill. A fill settles only if its entry is absent. The entry lives at least until both orders have
  expired; after that, the expiry check alone rejects a replay. The cursor is not used.

In both, the cumulative fill counter per order still bounds the quantity: `filled ≤ max_qty`.

### 4.2 Duplicates, retries and gaps (reference run)

| Case | Strict cursor | Idempotent identifier |
|---|---|---|
| The same fill submitted again in a new transaction | Rejected, `CursorNotIncreasing` (#3) [sim] | Rejected, `AlreadySettled` (#14) [sim] |
| The same fill in two transactions at once (two channels, same ledger) | — | One included and succeeded (`098ce9e1…0d68`). The other was included and **failed with #14** (`f2ade32f…f3a2`), charged 20,786 stroops [chain] |
| The identical signed envelope re-sent | Refused at submission, never included (`txTOO_LATE`, -3: its 300 s time bound had passed) | Same |
| A gap: fill at seq + 10 | **Accepted** (`d74537778d…3ed8`) [chain] | Accepted (any order) |
| A skipped fill presented after the gap | **Rejected for ever** (#3) [sim] | Accepted, if valid and not yet settled |
| Outcome unknown (timeout), then a retry | Read the cursor. If cursor ≥ fill, the fill was settled **or skipped**: the cursor cannot tell which | Read `is_settled(seq, idx)`: an exact answer |
| Duplicate inside one batch | Rejected: the second copy is not greater than the cursor (by construction; not separately tested) | Rejected (#14). The whole batch reverts [native test] |

The re-sent envelope did not exercise the sequence-number path, because its time bound had already
expired. That a consumed sequence number is refused is shown separately by the `txBAD_SEQ` result in
§3.4.

### 4.3 Is a monotonic fill counter sufficient for safe settlement?

**For safety against double settlement and overfill, yes.**

- No fill can settle twice: the cursor is strictly increasing.
- The cumulative per-order counter bounds quantity independently, so even a buggy exactly-once rule
  could not overfill an order.
- Both rules held in every test, on chain and in the 9 native tests.

**For completeness and liveness, no.**

1. **Gaps are silent and permanent.** The contract cannot know that skipped positions existed. A skipped
   fill (operator bug, or reordering, §4.4) becomes unsettleable the moment a later fill settles.
   Detection is entirely off-chain (§5).
2. **The cursor imposes a total order on the network's application order**, which no submitter
   controls (§4.4).
3. **Retries are ambiguous.** "cursor ≥ position" means *settled or skipped*. Telling them apart needs
   the event history.

### 4.4 Concurrent submission: does the strict cursor create unnecessary failures? Yes.

**Test.** Five channel accounts each submitted one settlement at the same time, with consecutive
cursors (and, separately, consecutive idempotent identifiers). The operator signed authorisation for
every transaction. There were three rounds per run, and two runs.

Reference run, cursor rounds. Notation: `cursor:result@application-order`; each round is one ledger.

| Round (ledger) | Results |
|---|---|
| 0 (5362757) | 114:**FAILED #3**@6, 115:**FAILED #3**@4, 116:ok@3, 117:ok@7, 118:ok@13 |
| 1 (5362761) | 119:**FAILED #3**@16, 120:ok@6, 121:ok@7, 122:**FAILED #3**@15, 123:ok@11 |
| 2 (5362767) | 124:**FAILED #3**@8, 125:ok@6, 126:ok@11, 127:**FAILED #3**@16, 128:ok@14 |

| Rule | Reference run | Replication run | Total |
|---|---|---|---|
| Strict cursor | 9 / 15 succeeded | 9 / 15 | **18 / 30 (40% failed)** |
| Idempotent identifier | 15 / 15 | 15 / 15 | **30 / 30** |

**What happened.**

- All five transactions of a round landed in **the same ledger**. They were applied in an order unrelated
  to submission order or cursor order. The reference run records the order (`applicationOrder`) for
  each.
- Every failure is a transaction applied **after** one with a higher cursor. In round 0, cursor 116 was
  applied first (position 3), so 114 (position 6) and 115 (position 4) failed.
- Each failure is **permanent**: after round 0 the cursor stood at 118, so fills 114 and 115 can never
  settle.
- **In a venue each of these is a settlement break.** Under the fail-closed rule of the design (§5 of
  the feasibility document), the venue would have halted **in every round of both runs**.

**The only safe ways to use a strict cursor:**

- **one transaction in flight at a time**, sending the next only after the previous result is known.
  This is measured at one transaction per ledger, about 5 s each. With k = 33 the ceiling is **33 fills
  per 5 s, about 6.6 fills per second** [estimate]. A failed or delayed transaction stalls everything
  behind it;
- or **per-lane cursors** (one cursor per channel, each lane strictly serial). This restores
  parallelism, but each lane then has the same gap and retry problems, and the journal-to-lane mapping
  becomes part of the protocol. Not measured.

**Idempotent identifiers remove the ordering dependency entirely.** They cost one extra written entry
per fill:

- persistent: +109,517 stroops per fill (+39%);
- temporary: +9,187 stroops per fill (+23%);
- 28 instead of 33 fills per batch.

They also make the instance read-only for settlement. A settlement transaction then writes no entry
shared with other settlements, except balances of the same accounts. The network can therefore apply
independent settlements in parallel clusters (up to 3 per ledger in the current configuration)
[estimate; not measured].

**Recommendation:** use idempotent fill identifiers, plus off-chain reconciliation (§5).

## 5. Reconciling settlement records against the journal

**Authorities** (as in the design):

- the **journal** is authoritative for what was matched;
- the **chain** for what moved.

**What the chain provides:**

- every settlement emits `("fill", seq, idx) → (price, qty)`, and the transaction arguments carry the
  full fill (both signed orders);
- the idempotent design also has `is_settled(seq, idx)`, readable while the marker lives (at least until
  order expiry);
- `filled(orderHash)` gives the cumulative quantity per order;
- anchors give the journal head at a fixed cadence.

**Reconciliation procedure** (off-chain, by the operator and by any auditor holding the journal):

1. **Bind the journal to an anchor.** The journal prefix up to an anchored head must hash-chain to that
   head (D-2). A mismatch means the journal was rewritten: stop.
2. **Extract** every execution in that prefix as `(seq, idx, maker order, taker order, price, qty)`.
3. **Index the chain.** Collect every `fill` event of the contract, with its transaction's arguments,
   up to the anchor's ledger plus *S_max*.
4. **Compare as sets keyed by `(seq, idx)`:**
   - in the journal and on chain with identical terms: **settled**;
   - on chain but not in the journal, or with different terms: **invented or altered fill**. This is
     an operator fault (possible only with the operator key): stop and report;
   - in the journal but not on chain:
     - **pending** while younger than *S_max* (resubmit; idempotent, so safe);
     - after *S_max*, a **settlement break**;
     - with the strict cursor, also a break as soon as the cursor has passed it (§4.4).
5. **Check quantities.** For each order, the sum of settled quantities must equal `filled(orderHash)`
   on chain and must not exceed `max_qty`.
6. **Check conservation.** The sum of balance changes per asset over the interval must be zero (G5).

**Practical requirements found by the spike:**

- **Event history needs its own archive.** The RPC serves events and transactions only for a limited
  retention window; the size of that window was not measured. Reconciliation over longer periods needs
  an indexer or history archives.
- **Settled markers are not a permanent record.** Temporary markers disappear after order expiry, by
  design. Reconciliation after that relies on events and the archived ledger.

**What reconciliation cannot do** (unchanged from the design, §7): prove fair ordering, completeness
of intake, or anything inside the unanchored window.

## 6. Withdrawals and order invalidation if the operator disappears

The measurement contract has **no** withdrawal or exit path; it holds no tokens. What follows is
analysis, using what was measured.

| Concern | Measured | Analysis |
|---|---|---|
| Invalidate all of one's signed orders | Epoch bump: 135,971 stroops, about 0.64 M instructions [chain]. Existing orders are then rejected (`StaleEpoch`, #9) [sim] | Cheap, and needs no operator. In a vault it must require the account's authorisation and take effect after delay *D* (free-option rule of the design). Here it was unauthenticated and immediate, for measurement only |
| Pending fills when the operator vanishes | Only the operator can settle | Unsettled engine fills simply never happen on chain. Users keep their on-chain balances, which are authoritative. No user loses funds through non-settlement; they lose the trade |
| Withdrawal without the operator | Not implementable here (no tokens) | The vault design must make exit operator-independent: user-authorised exit request, exit delay, then withdrawal. **Nothing in the measured limits prevents this**: an exit is a few persistent writes, comparable to the epoch bump |
| Balance entries reaching end of TTL | Persistent TTL is at least 7 days and at most 180 days [chain] | Balances will be archived if nobody extends them. A withdrawal must still work: it needs automatic or explicit restoration of archived persistent entries, paid by the user. **Not observed in this spike. It must be measured before a vault proposal** (§9) |
| Contract instance reaching end of TTL | Instance live until ledger 8,473,049 (about 180 days) [chain] | Anyone can extend or restore an entry's TTL by paying for it (inferred from the protocol; not tested). Restoration of the instance and code needs the same verification |
| Fill counters and settled markers expiring | Temporary entries live exactly until expiry + margin [chain] | Safe only if every order's expiry is within the counter's maximum TTL. **The vault must reject orders whose expiry exceeds about 3.1 M ledgers from now, minus margin.** The measurement contract only clamps the TTL. Otherwise a counter could expire before its order, re-enabling an overfill |

**Conclusion.**

- Invalidation is operator-independent and cheap.
- Withdrawal safety without the operator is **implementable within the limits**, but **not yet
  demonstrated**. Restoration of archived balances is the unverified dependency.

## 7. Does batching create unacceptable privacy, latency or failure trade-offs?

**Privacy: batching neither helps nor hurts much, but settlement itself leaks more than the venue's
hidden-order rules allow.**

- Every settlement, single or batched, publishes **both signed orders** in the transaction arguments:
  account, side, **limit price**, **maximum quantity**, expiry, epoch and salt. It also publishes the
  fill price and quantity.
- For a hidden or iceberg order this reveals **its total size and its limit price** at its first fill,
  contrary to the venue's hidden-order rules (H-1…H-9 in `MATCHING-RULES.md`; `PRIVACY-REVIEW.md`). Every later partial
  fill of the same order is linkable through the same order.
- The contract needs those terms to enforce the user's limits.
- Batching groups fills that were matched close together into one transaction. That reveals they fell
  in the same window, but per-fill settlement reveals timing even more finely.
- **This is a design decision, not a tuning question** (§9): either hidden orders are excluded from
  on-chain settlement, or their disclosure at settlement is accepted and documented, or the order terms
  are committed rather than revealed (research; out of scope).

**Latency: acceptable.**

- A single fill settles in one ledger (median 4.2 s from submission).
- A batch adds its accumulation window, at most one ledger (5 s) if batches are cut every ledger.
- Under a strict cursor with one transaction in flight, batching is the **only** way to exceed one fill
  per ledger.
- With idempotent identifiers and channel accounts, several single-fill transactions settle in the same
  ledger: 5 per ledger were observed.

**Settlement failure: acceptable with care.**

- A batch is atomic (native test): one bad fill reverts every fill in it, and the failed transaction is
  still charged its non-refundable fee. The failing fill must then be isolated, for example by bisection,
  and the others resubmitted.
- With idempotent identifiers that resubmission is safe. With a strict cursor, any reordering during
  resubmission creates gaps.
- Batches also sit near the RPC's envelope limit (§3.3): k = 33 is 90,992 bytes against the
  90,992–104,416 range where the public RPC began refusing.

**Cost: no meaningful saving** (§3.3).

**Batching is useful for throughput, not for cost or privacy.** Recommended:

- per-fill transactions over channel accounts with idempotent identifiers as the default;
- small batches (k ≤ 16) when demand exceeds a few fills per ledger;
- k well below the measured maximum, to stay clear of the written-entry and RPC size limits.

**Throughput ceiling** [estimate, from the ledger limits, assuming the venue had the whole testnet
Soroban capacity]:

| Bound | Limit | Fills per ledger |
|---|---|---|
| Instructions | 580 M per ledger at 2.7 M per single-fill transaction | about 215 |
| Written entries | 2,000 per ledger at 7 per fill | about 285 |

That is at most about 40–60 fills per second, shared with every other user of the network. **B1 is a
low-throughput settlement layer.** The engine must queue settlement and show fills as pending until
settled.

## 8. Limitations

**Scope.**

- Testnet only, through one public RPC provider. Two runs of about 12 minutes on 2026-10-24, with modest
  network load: inclusion fee 100 stroops.
- Mainnet configuration, fees and congestion may differ, and network limits change by validator vote.
- The samples are small: 74 latency samples, 30 concurrent submissions per rule.

**What the contract leaves out.**

- **No token movements.** Balances are internal numbers. A real vault moving assets through token
  contracts adds per-fill cost and entries that this spike does not measure. **Batch capacity and fees
  per fill above are therefore lower bounds on cost and upper bounds on capacity.**
- Registration, seeding and the epoch bump were unauthenticated. Real authorisation adds a signature
  check or an authorisation entry per call.
- There is no exit, withdrawal or delayed-invalidation logic.

**Not observed.**

- Archival and restoration (§3.6): the shortest persistent TTL is about 7 days.
- The cause of the RPC's `invalid_xdr` refusal and its exact size threshold: it lies between 90,992 and
  104,416 bytes, inferred from five submissions. The cause is presumed to be a limit of the endpoint.
  It is not documented by the provider, as far as was checked.
- The reason CPU per fill rises with batch size.
- Parallel execution of independent idempotent settlements across clusters (inferred from the protocol
  configuration only).
- Event retention of the RPC.
- The sequence-number path of an identical resubmission: it was refused by its time bound first (§4.2).

**Method.**

- The batch maximum is found by simulation. The maximums found were then submitted and included.
- The ledger-capacity throughput figures are arithmetic, not a load test.
- The first fill and the first anchor on each contract include a one-time rent for instance growth.
  The steady-state values are reported separately.
- The replication run predates three instrumentation changes:
  - recording application order and on-chain contract error codes (its failures were checked by hand:
    `34c20817…07d1` failed with contract error #3);
  - checking the assembled envelope size in the sweep (it reported k = 97 for shared accounts, which the
    RPC refused);
  - making the same-source test sequential.

  Its measured fees, latencies and concurrency outcomes agree with the reference run.

## 9. Go / no-go recommendation for B1

Go criteria from the design (`STELLAR-FEASIBILITY.md` §9):

| Criterion | Result |
|---|---|
| Per-fill settlement fits comfortably within transaction limits | **Met.** 0.7% of instructions, 3.5% of written entries, 2.4% of transaction size |
| Batches reach a useful k (about 10 or more) | **Met.** 33 (cursor) and 28 (idempotent), distinct accounts; both submitted |
| Fee per fill acceptable for a testnet demonstration | **Met.** 39,321–48,508 stroops (temporary storage); 282,958–392,475 (persistent) |
| Exit, delayed invalidation and counter lifetime implementable within limits | **Met for invalidation and counter lifetime** (measured costs and TTLs). **Exit and withdrawal not demonstrated** (no tokens), and depend on archival restoration |
| No unresolved over-fill, free-option or fund-stranding path | **Over-fill:** none found; enforced on chain and in native tests. **Free option:** unchanged from the design (*D* > *S_max*). **Fund stranding:** open until restoration of archived balances is verified |
| New finding: exactly-once rule under concurrency | **Strict cursor fails:** 40% of concurrent fills became permanent breaks. **Idempotent identifiers pass:** 30 / 30 |
| New finding: privacy of settled orders | **Conflicts with hidden-order guarantees:** signed order terms are public at settlement |

**Recommendation: conditional GO for a B1 vault design proposal.** This is **not** approval to implement
a vault. The proposal must incorporate:

1. **Idempotent fill identifiers instead of the strict cursor.** Settled markers in temporary storage
   with TTL to the later of the two orders' expiry, plus off-chain reconciliation (§5).
2. **A decision on hidden orders** (§7): exclude them from on-chain settlement, or accept and document
   their disclosure at settlement and update the privacy review. The current hidden-order guarantees
   cannot hold for orders settled by B1 as designed.
3. **Bounded order lifetime enforced by the contract.** Orders must expire within the counter's maximum
   TTL minus margin. Temporary storage for counters and markers (about 7× cheaper than persistent).
4. **Measurements before any vault code:**
   - archival and restoration of persistent balances and of the instance, using a local network with
     shortened TTL settings, or a run spanning more than 7 days;
   - token-transfer cost per fill with the actual asset contracts;
   - the RPC envelope limit with the chosen provider;
   - event retention.
5. **Starting values for timing** [estimate; for the proposal to confirm]:
   - *S_max* = 60 ledgers (5 minutes; observed inclusion is 1–2 ledgers, which leaves room for retries
     and RPC outages);
   - delayed invalidation *D* ≥ 2 × *S_max* = 120 ledgers;
   - `MAX_ORDER_LIFETIME` well below 3.1 M ledgers (for example 17,280, one day, as in the spike).
6. **Throughput expectations.** Settlement is the bottleneck: about 6.6 fills per second with a single
   in-flight transaction, and at most tens per second network-wide. Fills are shown as pending until
   settled. A trade-bust engine change is still needed for breaks (separate design, as before).

**No-go elements:**

- the strict monotonic cursor as specified;
- any claim that hidden orders keep their privacy through on-chain settlement;
- any production or mainnet use.

**If decision 2 is unacceptable** (hidden orders must stay private), B1 falls back to **B2 /
anchoring-only integration**. Anchoring alone is cheap (3,665 stroops per anchor) and preserves
tamper-evidence without publishing orders.
