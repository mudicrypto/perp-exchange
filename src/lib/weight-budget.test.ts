import { describe, expect, it } from "vitest";
import { WeightBudget } from "./weight-budget";

describe("WeightBudget", () => {
  it("allows requests until the window budget is used", () => {
    const budget = new WeightBudget(50, 60_000);
    expect(budget.tryConsume(20, 0)).toBe(true);
    expect(budget.tryConsume(20, 1_000)).toBe(true);
    expect(budget.tryConsume(20, 2_000)).toBe(false);
    expect(budget.used(2_000)).toBe(40);
  });

  it("frees weight as the window slides and reports when to retry", () => {
    const budget = new WeightBudget(40, 60_000);
    budget.tryConsume(20, 0);
    budget.tryConsume(20, 10_000);
    expect(budget.retryAfterMs(20, 30_000)).toBe(30_000);
    expect(budget.tryConsume(20, 60_001)).toBe(true);
  });
});
