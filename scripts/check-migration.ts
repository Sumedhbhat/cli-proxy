import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { InputError } from "../src/domain.ts";

// A rerunnable migration contract: production sources cannot silently fall back to
// unchecked JS, swallowed type errors, or timer-based background work.
const check = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const failures: string[] = [];
  for (const dir of ["src", "scripts", "public"]) {
    for (const name of yield* fs.readDirectory(dir)) {
      if (
        name.endsWith(".js") &&
        !["public/app.js", "scripts/claude-client.js"].includes(
          `${dir}/${name}`,
        )
      )
        failures.push(`${dir}/${name}: legacy implementation`);
      if (!name.endsWith(".ts")) continue;
      const source = yield* fs.readFileString(`${dir}/${name}`);
      const forbidden = [
        /@ts-(?:ignore|nocheck)/,
        /(?<!\.)\b(?:setInterval|setTimeout)\s*\(/,
        /:\s*any\b/,
        /\bas\s+any\b/,
        /\bexecFileSync\s*\(/,
      ];
      if (forbidden.some((pattern) => pattern.test(source)))
        failures.push(`${dir}/${name}: unchecked types or unmanaged work`);
    }
  }
  if (failures.length)
    return yield* new InputError({ status: 500, message: failures.join("\n") });
  console.log(
    "Migration contract passed: TypeScript sources, checked types, Effect-managed background work.",
  );
});
NodeRuntime.runMain(check.pipe(Effect.provide(NodeServices.layer)));
