import test from "node:test";
import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { makeEngine } from "../src/engine.ts";

test("engine request failures retain their original diagnostic cause", async (t) => {
  const cause = new Error("Connection reset");
  t.mock.method(globalThis, "fetch", async () => {
    throw cause;
  });
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* makeEngine({
        url: "http://engine.test",
        key: "test",
      });
      return yield* engine.request("config").pipe(Effect.flip);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  assert.equal(error._tag, "EngineError");
  assert.equal(error.cause, cause);
});
