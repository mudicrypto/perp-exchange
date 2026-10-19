# Runbook — Poison Command During Recovery (rule D-3)

**Applies to:** the local synthetic prototype. A real deployment needs this runbook reviewed, rehearsed
and wired to real tooling and approval (SECURITY-CHECKLIST §B, B4 and B8).

A **poison command** is a journaled command that makes the engine fault on every replay. Recovery
then stops with a `ReplayFaultError` (code `F10-replay-fault`) and returns no venue. The venue stays
down (fail-stop). Clients that saw `outcome-unknown` stay in that state until recovery succeeds.

**Never, under any circumstances:**

- edit, delete, reorder or skip journal entries;
- delete or reset commit records, or write them by hand;
- use `allowLegacySnapshot` or the offline migration to get around a fault.

The venue provides no skip or quarantine mechanism, by design.

## 1. Detect

Read the error's fields:

| Field | Use |
|---|---|
| `seq`, `entryHash` | Which entry. The hash proves it is the same bytes on every attempt. |
| `commandType` | Which code path (the message carries no payload) |
| `isFinalEntry` | `true`: no later command depends on it. `false`: later committed commands do. |
| `commitState` | `committed` (covered by the commit record), `uncommitted` (journaled but not committed; recovery would have rolled it forward), `no-commit-record` |
| `codeRulesVersion`, `snapshotRulesVersion`, `writerRulesVersion` | A difference points to an incompatible upgrade rather than a logic fault |
| `cause` | The original engine error. It may contain order data: handle it as confidential, and never paste it into tickets or chat. |

## 2. Preserve

Take read-only copies of the journal store, both commit-record slots and every snapshot **before**
anything else. Record their sha256 values.

## 3. Classify

| Finding | Likely cause | Go to |
|---|---|---|
| `writerRulesVersion` or `snapshotRulesVersion` differs from `codeRulesVersion` | the code was upgraded incompatibly | 4a |
| Versions equal, fault reproducible | engine logic fault (bug) | 4b |
| Fault not reproducible on the copies | environment problem (memory, runtime version) | 4c |

## 4. Remedies (allowed)

- **4a. Roll back** to the code version that wrote the journal (the writer's rules version). Recover.
  Then plan the upgrade properly: snapshot under the old version, migrate the state deliberately, and
  bump `VENUE_RULES_VERSION`.
- **4b. Fix the code** so the same journal replays without the fault. Prove the fix on the copies: a
  full replay must reproduce the recorded output chain for every entry **before** `seq`, and the
  committed outcome at `seq` must be consistent with what clients may have been told. The fix and
  that evidence need independent review. Then recover.
- **4c. Fix the environment.** Recover on the copies first.

## 5. After recovery

Clients follow the reconciliation procedure (DURABILITY-PROTOCOL §5.3) before sending new commands.
Record the incident: seq, entry hash, cause classification, remedy, reviewer.
