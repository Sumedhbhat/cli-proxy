import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, FileSystem } from "effect";
import { parseEnv } from "node:util";
import { InputError } from "./domain.ts";

declare const CREDENTIAL_ENV_PATH: string;
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const key = parseEnv(
    yield* fs.readFileString(CREDENTIAL_ENV_PATH),
  ).PROXY_API_KEY;
  if (!key)
    return yield* new InputError({
      status: 400,
      message: "Proxy API key is missing",
    });
  process.stdout.write(key);
});
NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer)));
