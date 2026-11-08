import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { collectT3History } from "../src/t3-history.ts";
import { collectNativeHistory } from "../src/native-history.ts";
import { insertHistory } from "../src/quota-history.ts";
import type { HistoryImport } from "../src/quota-history.ts";
import { installationRoot, atomicWrite } from "../src/deployment.ts";
const option = (name: string) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
try {
  const prior = new Date();
  prior.setUTCDate(1);
  prior.setUTCMonth(prior.getUTCMonth() - 1);
  const month = option("month") || prior.toISOString().slice(0, 7);
  const bin = await fs.realpath(join(homedir(), ".local/bin")).catch(() => "");
  const home =
    process.env.CLI_PROXY_CLIENT_HOME ||
    (bin.endsWith("/.local/bin") ? dirname(dirname(bin)) : homedir());
  const file = option("file");
  const userdata = option("t3") || join(home, ".t3/userdata");
  const history: HistoryImport = file
    ? JSON.parse(await fs.readFile(file, "utf8"))
    : await collectT3History(userdata, month);
  if (!file && month !== "all") {
    const native = await collectNativeHistory(
      month,
      option("codex") || join(home, ".codex/sessions"),
      option("claude") || join(home, ".claude/projects"),
    );
    history.quota.push(...native.quota);
  }
  if (
    history.version !== 1 ||
    !Array.isArray(history.usage) ||
    !Array.isArray(history.quota)
  )
    throw new Error("Invalid history export");
  if (option("export")) {
    await atomicWrite(option("export")!, JSON.stringify(history));
    console.log(
      `Exported sanitized metadata: ${history.usage.length} usage observations, ${history.quota.length} quota observations.`,
    );
  } else {
    const result = insertHistory(
      join(process.env.CLI_PROXY_INSTALLATION || installationRoot(), ".local"),
      history,
    );
    await atomicWrite(
      join(
        process.env.CLI_PROXY_INSTALLATION || installationRoot(),
        ".local/history-status.json",
      ),
      JSON.stringify({
        at: new Date().toISOString(),
        sourceCacheAt: history.sourceCacheAt || null,
        sourceCacheVersion: history.sourceCacheVersion || null,
        observations: history.usage.length,
        quotaObservations: history.quota.length,
      }),
    );
    console.log(
      `Imported ${result.usage} usage and ${result.quota} quota observations. Repeating the import does not duplicate records.`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
