// A session that runs one sync cycle in its own process, so a test can kill it in the
// middle of its live update (tests/core/sync-cycle.test.ts). The cycle's input is one
// JSON argument; the result goes to stdout.
import { runCycle } from "../../../core/sync/cycle.ts";

const input = JSON.parse(process.argv[2] ?? "{}");
console.log(JSON.stringify(await runCycle(input)));
