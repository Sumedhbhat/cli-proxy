import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";

const program = Effect.gen(function* () {
  const root = fileURLToPath(new URL("../.local/", import.meta.url));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(
      `${root}cli-proxy-api`,
      ["-config", `${root}engine.yaml`],
      { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    ),
  );
  process.exitCode = yield* child.exitCode;
});
NodeRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
