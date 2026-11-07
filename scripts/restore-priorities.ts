import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import { resolve } from "node:path";
import { makeEngine } from "../src/engine.ts";
import { makeStorage } from "../src/storage.ts";
import { InputError } from "../src/domain.ts";

const restore = Effect.gen(function* () {
  yield* Effect.try(() => process.loadEnvFile(".env")).pipe(
    Effect.catch(() => Effect.void),
  );
  if (!process.env.ENGINE_MANAGEMENT_KEY)
    return yield* new InputError({
      status: 400,
      message: "ENGINE_MANAGEMENT_KEY is required",
    });
  const storage = yield* makeStorage(resolve(process.env.DATA_DIR || ".local"));
  if ((yield* storage.loadSettings).scheduler)
    return yield* new InputError({
      status: 409,
      message:
        "Pause the scheduler in the console, then stop the console before restoring priorities.",
    });
  const engine = yield* makeEngine({
    url: process.env.ENGINE_URL || "http://127.0.0.1:8317",
    key: process.env.ENGINE_MANAGEMENT_KEY,
  });
  const backup = yield* storage.readBackup;
  const accounts = yield* engine.accounts();
  let restored = 0;
  for (const item of backup) {
    const account = accounts.find((a) => a.name === item.name);
    if (account) {
      yield* engine.patch(account, { priority: item.priority });
      restored++;
    }
  }
  console.log(
    `Restored original priorities for ${restored} credentials. Scheduler remains paused.`,
  );
});
NodeRuntime.runMain(restore.pipe(Effect.provide(NodeServices.layer)));
