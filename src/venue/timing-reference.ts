import type { BookSideApi, PriceRange } from "./book.ts";
import { MatchingEngine } from "./engine.ts";
import { ReferenceBookSide } from "./reference-book.ts";
import type { Side } from "./types.ts";

/**
 * BENCHMARK/TEST TOOLING ONLY: the production engine running on the Milestone 11 reference book, so the timing
 * harness can measure both books in one process (Milestone 12 A/B). Never used by the venue.
 */
export class ReferenceBookEngine extends MatchingEngine {
  protected override createBookSide(side: Side, onDisplayedChange: (side: Side, priceTicks: number) => void, range: PriceRange): BookSideApi {
    return new ReferenceBookSide(side, onDisplayedChange, range);
  }
}
