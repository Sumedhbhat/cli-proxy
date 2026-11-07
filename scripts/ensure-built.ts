import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";
import { command } from "../src/command.ts";
import { InputError } from "../src/domain.ts";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (yield* fs.exists(`${root}node_modules/esbuild/package.json`)) {
    yield* command(process.execPath, ["scripts/build.ts"], { cwd: root });
    return;
  }
  // A deployed service has runtime dependencies and prebuilt artifacts.
  for (const path of [
    "public/app.js",
    "scripts/claude-client.js",
    "dist/client-api-key.cjs",
  ]) {
    if (!(yield* fs.exists(`${root}${path}`)))
      return yield* new InputError({
        status: 500,
        message:
          "Build artifacts are missing. Run npm ci and npm run build in the checkout.",
      });
  }
});
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
