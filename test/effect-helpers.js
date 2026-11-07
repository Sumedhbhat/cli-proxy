import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { makeEngine } from "../src/engine.ts";

// Tests keep using Promises at Node's test-runner boundary.
export async function createEngine(options) {
  const service = await Effect.runPromise(
    makeEngine(options).pipe(Effect.provide(NodeServices.layer)),
  );
  return Object.fromEntries(
    Object.entries(service).map(([name, operation]) => [
      name,
      (...args) => Effect.runPromise(operation(...args)),
    ]),
  );
}
