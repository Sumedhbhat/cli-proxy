// Builds the engine's usage-ledger plugin from engine-plugin/ (Go standard
// library only) into .local/plugins/, with a manifest describing the build.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../src/command.ts";
import { LEDGER_PLUGIN_ID } from "../src/ledger-setup.ts";

// The toolchain the reviewed artifact was built and tested with.
export const PINNED_GO = "go1.27.3";
const root = fileURLToPath(new URL("../", import.meta.url));
const go = process.env.GO || "go";
const cc = process.env.CC || "cc";

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const version = (yield* command(go, ["env", "GOVERSION"], {
    capture: true,
  })).trim();
  if (version !== PINNED_GO)
    console.warn(
      `Building with ${version}; the pinned toolchain is ${PINNED_GO}.`,
    );
  const outDir = join(root, ".local/plugins");
  yield* fs.makeDirectory(outDir, { recursive: true, mode: 0o700 });
  const output = join(outDir, `${LEDGER_PLUGIN_ID}.so`);
  const env = { CGO_ENABLED: "1", CC: cc, GOTOOLCHAIN: "local" };
  yield* command(go, ["vet", "./..."], {
    cwd: join(root, "engine-plugin"),
    env,
  });
  yield* command(
    go,
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-buildmode=c-shared",
      "-ldflags=-s -w",
      "-o",
      output,
      ".",
    ],
    { cwd: join(root, "engine-plugin"), env },
  );
  yield* fs.remove(join(outDir, `${LEDGER_PLUGIN_ID}.h`), { force: true });
  yield* fs.chmod(output, 0o600);
  const commit = yield* command("git", ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
    quiet: true,
  }).pipe(
    Effect.map((value) => value.trim()),
    Effect.orElseSucceed(() => null),
  );
  const sha256 = createHash("sha256")
    .update(yield* fs.readFile(output))
    .digest("hex");
  yield* fs.writeFileString(
    join(outDir, `${LEDGER_PLUGIN_ID}.json`),
    JSON.stringify(
      {
        plugin: LEDGER_PLUGIN_ID,
        sha256,
        go: version,
        cc,
        sourceCommit: commit,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`Built ${output}\nSHA-256 ${sha256}`);
});
NodeRuntime.runMain(build.pipe(Effect.provide(NodeServices.layer)));
