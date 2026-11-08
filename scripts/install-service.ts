import { fileURLToPath } from "node:url";
import { deploy } from "../src/deployment.ts";

// Wait for rollback before exiting on Ctrl-C or SIGTERM.
const abort = new AbortController();
const stop = () => abort.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await deploy(fileURLToPath(new URL("../", import.meta.url)), abort.signal);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = abort.signal.aborted ? 130 : 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
