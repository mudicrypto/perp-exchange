# Runbook: commit-anchor bootstrap (rule D-6)

**Prototype only.** Local and synthetic. `approvedBy` and `reason` are free-text metadata, **not** an
authenticated approval.

## When

Use this runbook only when recovery refuses with one of:

- `no commit anchor for a non-empty journal`, for example a Milestone 10 journal being moved to an anchored
  store, or an anchor store that was lost;
- `commit anchor is unreadable` / `commit anchor record is invalid`, for example after a torn anchor write.

**Never bootstrap over a readable anchor.** A refusal such as `journal is missing anchored entries`,
`anchored entry … is truncated` or `commit anchor hash does not match` means **acknowledged entries were
lost**. The venue refuses a bootstrap in that case. Establish the truth from outside the journal before
anything else: client acknowledgements, the public tape (`publicSeq`), account events.

## Steps

1. Verify the journal is intact by your own means. Recovery checks hash-chain integrity, but it cannot know
   about entries that were lost before the anchor existed.
2. Recover with a **full replay**, with no snapshot:

   ```ts
   Venue.recover(options /* store + anchor */, undefined, undefined, {
     bootstrapAnchor: { reason: "<why the anchor is missing or unreadable>", approvedBy: "<operator — free text>" },
   });
   ```

3. **The venue:**
   - verifies and replays the whole journal;
   - repairs a torn journal tail as usual;
   - journals `admin.anchor-bootstrap { seq, hash, prior: "missing" | "unreadable", reason, approvedBy }`,
     which writes the first anchor.
4. **If the bootstrap call fails** with `outcome-unknown`, nothing may have been anchored; repeat it.
5. **From now on**, plain recovery is anchored. `report.anchoredSeq` shows the anchor found.

## Limits

- The bootstrap anchors the journal **as it is now**. Entries lost before the bootstrap are not detected.
- The in-memory anchor detects integrity faults only; it is not proof of physical durability.
