import { fileURLToPath } from "node:url";
import { runSetup } from "../src/setup-workflow.ts";

const abort = new AbortController();
const stop = () => abort.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  if (process.argv.includes("--help")) {
    console.log(
      "npm run setup: install dependencies, prepare engine and ledger plugin, install recovery tools, deploy services, configure clients and T3, and verify readiness. Requires Linux, Node 24+, npm, tar, Go 1.26+, a C compiler and systemd user services. Rerun the same command for updates. Provider login remains interactive.",
    );
  } else
    await runSetup(fileURLToPath(new URL("../", import.meta.url)), {
      signal: abort.signal,
    });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = abort.signal.aborted ? 130 : 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
