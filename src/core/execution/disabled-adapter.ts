import type { ExecutionAdapter, SubmitResult } from "../ports";

export const EXECUTION_DISABLED_MESSAGE =
  "Order submission is not available in this milestone. Nova is running in read-only mode.";

/**
 * The only execution adapter in Milestone 1. It never contacts a venue and
 * rejects every request, so no code path can place a real order.
 */
export class DisabledExecutionAdapter implements ExecutionAdapter {
  readonly mode = "disabled" as const;

  constructor(readonly venueId: string) {}

  async submit(): Promise<SubmitResult> {
    return { ok: false, code: "execution-disabled", message: EXECUTION_DISABLED_MESSAGE };
  }

  async cancel(): Promise<SubmitResult> {
    return { ok: false, code: "execution-disabled", message: EXECUTION_DISABLED_MESSAGE };
  }
}
