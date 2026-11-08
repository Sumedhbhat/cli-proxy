import { installationRoot, monitor, rollback } from "../src/deployment.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function main() {
  const root = process.env.CLI_PROXY_INSTALLATION || installationRoot();
  try {
    switch (process.argv[2]) {
      case "monitor":
        await monitor(root);
        break;
      case "rollback":
        await rollback(root);
        break;
      case "status":
        for (const name of ["deployment.json", "incident.json"]) {
          console.log(
            name,
            await readFile(join(root, name), "utf8").catch(() => "No record"),
          );
        }
        break;
      default:
        throw new Error("Usage: maintenance.cjs monitor|status|rollback");
    }
  } catch (error) {
    // A running deployment owns recovery. Timer retries next minute.
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "Another deployment is running") {
      if (process.argv[2] !== "monitor") console.error(message);
      process.exitCode = 1;
    }
  }
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
