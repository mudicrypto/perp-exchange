/**
 * `npm run --silent venue:showcase:verify < showcase.html` — verifies a showcase bundle (viewer page or
 * JSON) read from standard input: replays every embedded journal and checks every recorded hash and
 * feed, then regenerates the bundle from this code and requires the same bundle hash (`--no-regenerate`
 * skips that step). Exit code 0 only if everything matches (docs/venue/SHOWCASE.md).
 */
import { parseShowcase, verifyShowcase } from "../showcase.ts";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let result;
  try {
    result = verifyShowcase(parseShowcase(input), { regenerate: !process.argv.includes("--no-regenerate") });
  } catch (error) {
    console.log(`not a showcase bundle: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  for (const line of result.lines) console.log(line);
  for (const finding of result.findings) console.log(`FAILED ${finding}`);
  console.log(result.ok ? "VERIFIED" : "NOT VERIFIED");
  process.exitCode = result.ok ? 0 : 1;
});
