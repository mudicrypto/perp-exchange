# Runbook: poison command (VR-18, rule D-7)

**Prototype only.** Everything here is local and synthetic. `approvedBy`, `reason` and `notes` are
free-text metadata: they are **not** an authenticated approval and give no access control.

## Symptom

- The venue stopped with `outcome-unknown` at seq *S*, then every recovery fails with
  `replay stopped at seq S: …`.
- The command at seq *S* faults deterministically: the same build and the same journal produce the same
  fault every time (D-1).

## 1. Establish the facts (read only)

1. Confirm *S* is the **final** valid journal entry (`readJournal(store.read())`).
   - If later entries exist, the fault is **not** a live poison: something made replay non-deterministic (a
     code, runtime or dependency change). **Do not quarantine.**
   - Restore the exact build that wrote the journal and recover with it (THREAT-MODEL T-I7).
2. Record the entry's `seq`, `hash` and command. Note the submitting account.
3. Confirm the recovery runs the **same engine build** that faulted live.
4. Collect downstream evidence:
   - The highest `publicSeq` any public consumer received.
   - The highest `accountSeq` each private consumer received, including the submitting account.
   - What the submitting client was told: `outcome-unknown`, or no response.
   - Anything that may have acted on outputs of seq *S*. There should be nothing, because a live fault
     produces no outputs.
5. If any consumer saw output beyond the state before *S*, or the client was told the command succeeded,
   **stop**. The command had an acknowledged effect and must not be voided; escalate.

## 2. Quarantine (one recovery call)

```ts
Venue.recover(options /* store + anchor */, undefined, undefined, {
  quarantine: {
    seq: S,
    hash: "<entry hash>",
    reason: "<what faulted and why it is safe to void>",
    approvedBy: "<operator name — free text, not authenticated>",
    suspendAccount: true | false, // suspend the submitting account in the same record
    evidence: {
      clientOutcome: "outcome-unknown", // or "no-response"
      sameEngineBuild: true,
      observedPublicSeq: <highest publicSeq seen downstream>,
      observedAccountSeqs: { "<account>": <highest accountSeq seen>, … },
      notes: "<where the evidence came from>",
    },
  },
});
```

**The venue checks, and refuses with both stores untouched, unless:**

- *S* is the final valid entry;
- the hash matches;
- *S* is not an operator record and is not already quarantined;
- the fault reproduces on a scratch copy of the state before *S*;
- the observed sequences do not exceed those that existed before *S*;
- the evidence includes the submitting account;
- no snapshot includes *S*;
- `suspendAccount` is used only with an account-scoped command.

**On success:**

- *S* is voided. The client receives `rejected` / `request-rejected` with reason `quarantined`.
- `admin.quarantine` is journaled and anchored as seq *S*+1.
- The venue is running.

## 3. After the quarantine

- **Plain recoveries need no operator input from now on.** Full replay, snapshot + suffix and replicas all
  void *S* because the journal says so.
- **The identical command is refused** before journaling (`quarantined`). A variant may hit the same bug,
  so keep the account suspended (`suspendAccount`) until the bug is fixed.
- **If the quarantine call itself failed** with `outcome-unknown`:
  - Retry the same call. If the record was lost (a torn write), it is written again.
  - If the call is refused as "already quarantined", recover without the request.
- **A Milestone 10 reader can no longer read this journal** (`invalid command` at the record). This is
  expected: the journal schema gained operator record types (DURABILITY-AND-RETENTION §2).
