import test from "node:test";
import assert from "node:assert/strict";
import { Deferred, Effect, Fiber, Redacted } from "effect";
import { makeApplication } from "../src/application.ts";
import { AppConfig } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { Storage } from "../src/storage.ts";

for (const { label, ownerScope, waiterScope, expectedCalls, expectedB } of [
  {
    label: "different accounts run their own refresh",
    ownerScope: "A",
    waiterScope: "B",
    expectedCalls: ["A", "B"],
    expectedB: 75,
  },
  {
    label: "a targeted refresh cannot satisfy refresh all",
    ownerScope: "A",
    waiterScope: undefined,
    expectedCalls: ["A", "A", "B"],
    expectedB: 75,
  },
  {
    label: "a full refresh covers a queued account",
    ownerScope: undefined,
    waiterScope: "B",
    expectedCalls: ["A", "B"],
    expectedB: 75,
  },
  {
    label: "matching account refreshes share completed work",
    ownerScope: "A",
    waiterScope: "A",
    expectedCalls: ["A"],
    expectedB: 50,
  },
  {
    label: "matching full refreshes share completed work",
    ownerScope: undefined,
    waiterScope: undefined,
    expectedCalls: ["A", "B"],
    expectedB: 75,
  },
]) {
  test(label, { timeout: 5000 }, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make();
        const release = yield* Deferred.make();
        const calls = [];
        let requested = false,
          gated = false;
        const accounts = ["A", "B"].map((id) => ({
          id,
          name: `${id}.json`,
          provider: "codex",
          email: "",
          disabled: false,
          runtimeOnly: false,
          status: "active",
          priority: 0,
          supportsQuota: true,
          accountId: null,
          plan: "",
          success: 0,
          failed: 0,
          quota: null,
          quotaError: null,
        }));
        const app = yield* makeApplication.pipe(
          Effect.provideService(AppConfig, {
            demo: false,
            dataDir: "",
            port: 0,
            engineURL: "http://unused",
            apiKey: Redacted.make("unused"),
            managementKey: Redacted.make("unused"),
          }),
          Effect.provideService(Engine, {
            accounts: () => Effect.succeed(accounts),
            request: () => Effect.succeed({ routing: {} }),
            authFiles: () => Effect.succeed([]),
            quota: (account) =>
              Effect.gen(function* () {
                if (requested) {
                  calls.push(account.id);
                  if (!gated) {
                    gated = true;
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                  }
                }
                return {
                  windows: [
                    {
                      id: "weekly",
                      label: "Weekly limit",
                      remaining: requested ? 75 : 50,
                      resetsAt: null,
                    },
                  ],
                  fetchedAt: new Date().toISOString(),
                  availableResets: null,
                  nextResetExpiresAt: null,
                  plan: null,
                };
              }),
          }),
          Effect.provideService(Storage, {
            loadSettings: Effect.succeed({
              scheduler: false,
              intervalSeconds: 60,
            }),
            loadQuota: Effect.succeed([]),
            saveQuota: () => Effect.void,
          }),
        );
        yield* app.refresh();
        requested = true;
        const owner = yield* app.refresh(ownerScope).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const waiter = yield* app.refresh(waiterScope).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        yield* Fiber.join(waiter);
        const state = yield* app.snapshot;
        assert.deepEqual(calls, expectedCalls);
        assert.equal(
          state.accounts.find((a) => a.id === "B").quota.windows[0].remaining,
          expectedB,
        );
        assert.equal(state.connected, true);
      }).pipe(Effect.timeout(3000)),
    );
  });
}
