// No application imports or credential helper. This runs when the proxy is down.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export function directInvocation(
  provider: string,
  args: string[],
  inherited: NodeJS.ProcessEnv = process.env,
) {
  const env = { ...inherited };
  for (const name of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "CLI_PROXY_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CODEX_API_KEY",
  ])
    delete env[name];
  const home = inherited.CLI_PROXY_CLIENT_HOME || homedir();
  env.CODEX_HOME = join(home, ".codex");
  env.CLAUDE_CONFIG_DIR = join(home, ".claude");
  const binary = join(home, ".local/bin", provider);
  if (provider === "codex")
    return {
      binary,
      env,
      args: [
        "-c",
        'model_provider="openai"',
        "-c",
        'chatgpt_base_url="https://chatgpt.com/backend-api/"',
        ...args,
      ],
    };
  if (provider === "claude")
    return {
      binary,
      env,
      args: [
        "--setting-sources",
        "",
        "--settings",
        JSON.stringify({
          apiKeyHelper: "",
          env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
        }),
        ...args,
      ],
    };
  throw new Error("Choose codex or claude");
}
export async function direct(provider: string, args: string[]) {
  const invocation = directInvocation(provider, args);
  const child = spawn(invocation.binary, invocation.args, {
    env: invocation.env,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => child.kill(signal));
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
