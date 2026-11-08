import { Data, Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class CommandError extends Data.TaggedError("CommandError")<{
  readonly message: string;
  readonly exitCode: number;
}> {}
export const command = Effect.fn("Command.run")(function* (
  binary: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly capture?: boolean;
    readonly quiet?: boolean;
    // Added to the inherited environment.
    readonly env?: Record<string, string>;
  } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(binary, args, {
          cwd: options.cwd,
          ...(options.env ? { env: options.env, extendEnv: true } : {}),
          stdin: "inherit",
          stdout: options.capture
            ? "pipe"
            : options.quiet
              ? "ignore"
              : "inherit",
          stderr: options.quiet ? "ignore" : "inherit",
        }),
      );
      const [output, code] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: 2 },
      );
      if (code !== 0)
        return yield* new CommandError({
          message: `${binary} failed with exit code ${code}`,
          exitCode: code,
        });
      return output;
    }),
  );
});
