import { Effect, FileSystem } from "effect";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions, followUpdates } from "./claude-binary.ts";

export const fallbackClaudeVersion = "2.1.310";
export const defaultClaudeBinary = () =>
  process.env.CLI_PROXY_CLAUDE_BINARY || [
    "claude",
    join(homedir(), ".local/bin/claude"),
  ];

// This adapter kills even binaries ignoring SIGTERM, on timeout or interruption.
const installedVersion = (binary: string) =>
  Effect.callback<string | undefined>((resume) => {
    const child = execFile(
      binary,
      ["--version"],
      { timeout: 10000, killSignal: "SIGKILL" },
      (error, stdout) => {
        resume(
          Effect.succeed(
            !error ? /^(\d+\.\d+\.\d+)\b/.exec(stdout.trim())?.[1] : undefined,
          ),
        );
      },
    );
    return Effect.sync(() => {
      child.kill("SIGKILL");
    });
  });

// Cache is owned by the engine Layer, so runtime instances cannot share it.
export const claudeUserAgent = Effect.fn("Claude.makeUserAgent")(function* (
  configured: string | ReadonlyArray<string> = defaultClaudeBinary(),
) {
  const fs = yield* FileSystem.FileSystem;
  let cache: { key: string; at: number; version: string } | undefined;
  return Effect.gen(function* () {
    const binaries = yield* Effect.forEach(
      typeof configured === "string" ? [configured] : configured,
      followUpdates,
    );
    const key = binaries.join("\0");
    if (cache && cache.key === key && Date.now() - cache.at < 3600000)
      return `claude-cli/${cache.version} (external, cli)`;
    let version = fallbackClaudeVersion;
    for (const binary of binaries) {
      const found = yield* installedVersion(binary);
      if (found) {
        version =
          compareVersions(found, fallbackClaudeVersion) >= 0
            ? found
            : fallbackClaudeVersion;
        break;
      }
    }
    cache = { key, at: Date.now(), version };
    return `claude-cli/${version} (external, cli)`;
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
});
