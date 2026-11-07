import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { makeEngine } from "../src/engine.ts";
import type { EngineOptions } from "../src/engine.ts";
import type { QuotaAccount } from "../src/domain.ts";

// Promise boundary for the live provider-probe tests; the service stays in Effect.
export async function createEngine(options: EngineOptions) {
  const engine = await Effect.runPromise(
    makeEngine(options).pipe(Effect.provide(NodeServices.layer)),
  );
  return {
    quota: (account: QuotaAccount) => Effect.runPromise(engine.quota(account)),
  };
}
