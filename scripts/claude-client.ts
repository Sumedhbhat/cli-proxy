#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSink from "@effect/platform-node-shared/NodeSink";
import * as NodeStream from "@effect/platform-node-shared/NodeStream";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { restoreProxyReset } from "../src/claude-compat.ts";
import { claudeBinary } from "../src/claude-binary.ts";

// Preserve unmodified frames byte for byte, including split UTF-8 and a final unterminated line.
function resetTransform() {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const convert = (line: string) => {
    try {
      const frame: unknown = JSON.parse(line);
      const restored = restoreProxyReset(frame);
      return restored === frame ? line : JSON.stringify(restored);
    } catch {
      return line;
    }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending += decoder.write(chunk);
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        this.push(convert(pending.slice(0, index)) + "\n");
        pending = pending.slice(index + 1);
      }
      done();
    },
    flush(done) {
      pending += decoder.end();
      if (pending) this.push(convert(pending));
      done();
    },
  });
}
const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const streaming = args.some(
    (a, i) =>
      a === "--output-format=stream-json" ||
      (a === "--output-format" && args[i + 1] === "stream-json"),
  );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(yield* claudeBinary, args, {
      stdin: "inherit",
      stdout: streaming ? "pipe" : "inherit",
      stderr: "inherit",
    }),
  );
  const output = streaming
    ? child.stdout.pipe(
        NodeStream.pipeThroughDuplex({ evaluate: resetTransform }),
        Stream.run(
          NodeSink.fromWritable({
            evaluate: () => process.stdout,
            endOnDone: false,
            onError: (error) => error,
          }),
        ),
      )
    : Effect.void;
  const [, code] = yield* Effect.all([output, child.exitCode], {
    concurrency: 2,
  });
  process.exitCode = code;
});
const hangup = Effect.callback<void>((resume) => {
  const handler = () => {
    process.exitCode = 129;
    resume(Effect.void);
  };
  process.once("SIGHUP", handler);
  return Effect.sync(() => {
    process.off("SIGHUP", handler);
  });
});
NodeRuntime.runMain(
  program.pipe(
    Effect.raceFirst(hangup),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
