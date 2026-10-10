import type { ExecutionAdapter, SubmitResult } from "../ports";

export const EXECUTION_DISABLED_MESSAGE =
  "Order submission is not available for live venues in this milestone. Nova is running read-only.";

/**
 * Execution adapter for live venues in this milestone. It never contacts a
 * venue and rejects every request, so no code path can place a real order.
 */
export class DisabledExecutionAdapter implements ExecutionAdapter {
  readonly mode = "disabled" as const;

  constructor(readonly venueId: string) {}

  async submit(): Promise<SubmitResult> {
    return { ok: false, code: "execution-disabled", message: EXECUTION_DISABLED_MESSAGE, order: null };
  }

  async cancel(): Promise<SubmitResult> {
    return { ok: false, code: "execution-disabled", message: EXECUTION_DISABLED_MESSAGE, order: null };
  }

  async cancelAll(): Promise<number> {
    return 0;
  }
}
