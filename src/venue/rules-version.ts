/**
 * Version of the venue's deterministic rules: matching, risk, state machine and output format
 * (MATCHING-RULES D-7). Bump it whenever a change could make a replay of the same journal produce a
 * different state or different outputs. Snapshots record it, and a snapshot written under another
 * version is not restored. Commit records record the writer's version for diagnostics only.
 */
export const VENUE_RULES_VERSION = "nova-venue-rules/11";
