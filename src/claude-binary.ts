import { Effect, FileSystem } from "effect";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const semver = /^\d+\.\d+\.\d+$/;
const parts = (version: string) => version.split(".").map(Number);
export const compareVersions = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
export const followUpdates = Effect.fn("Claude.followUpdates")(function* (
  binary: string,
) {
  const dir = dirname(binary),
    current = basename(binary);
  if (basename(dir) !== "versions" || !semver.test(current)) return binary;
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs
    .readDirectory(dir)
    .pipe(Effect.catch(() => Effect.succeed([] as string[])));
  const candidates = names
    .filter((name) => semver.test(name) && compareVersions(name, current) > 0)
    .sort(compareVersions)
    .reverse();
  for (const name of candidates) {
    const path = join(dir, name);
    const executable = yield* Effect.gen(function* () {
      yield* Effect.tryPromise(() => access(path, 1));
      return (yield* fs.stat(path)).type === "File";
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (executable) return path;
  }
  return binary;
});
export const claudeBinary = Effect.suspend(() =>
  process.env.CLI_PROXY_CLAUDE_BINARY
    ? followUpdates(process.env.CLI_PROXY_CLAUDE_BINARY)
    : Effect.succeed(join(homedir(), ".local/bin/claude")),
);
