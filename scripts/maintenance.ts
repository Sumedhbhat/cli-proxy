import { installationRoot, monitor, rollback } from "../src/deployment.ts";
import { diagnosticReport } from "../src/diagnostics.ts";
import { atomicWrite } from "../src/deployment.ts";

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
      case "diagnostics": {
        const report = await diagnosticReport(root);
        const output = process.argv
          .find((v) => v.startsWith("--output="))
          ?.slice(9);
        const body = JSON.stringify(report, null, 2) + "\n";
        if (output) {
          await atomicWrite(output, body);
          console.log(`Diagnostics saved to ${output}`);
        } else if (
          process.argv[2] === "diagnostics" ||
          process.argv.includes("--json")
        )
          console.log(body);
        else {
          console.log(`CLI Proxy: ${report.healthy ? "healthy" : "unhealthy"}`);
          console.log(
            `Release: ${report.expected?.release || "not installed"}`,
          );
          console.log(
            `Commit: ${report.expected?.commit || "unknown"}${report.expected?.dirty ? " (uncommitted changes)" : ""}`,
          );
          console.log(
            `Engine: ${report.expected?.engineVersion || "unknown"} · Build: ${report.expected?.build || "unknown"}`,
          );
          console.log(
            `Running release: ${report.running?.release || "unreachable"}`,
          );
          for (const s of report.services)
            console.log(`${s.name}: ${s.state} · restarts ${s.restarts}`);
          console.log(
            `Last heartbeat: ${report.heartbeat?.at || "none"}${report.heartbeatStale ? " (stale)" : ""}`,
          );
          if (report.gatewayReason)
            console.log(
              `Failure: ${report.startupReason || report.gatewayReason}`,
            );
        }
        if (!report.healthy) process.exitCode = 1;
        break;
      }
      default:
        throw new Error(
          "Usage: maintenance.cjs monitor|status|diagnostics|rollback",
        );
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
